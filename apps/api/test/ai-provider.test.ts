import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CircuitBreaker, CircuitOpenError } from '../src/ai/circuit-breaker.js'
import { AiProviderError, OpenAiMediaProvider } from '../src/ai/openai-provider.js'

describe('AI provider contracts', () => {
  it('parses bounded vision output and embeddings without storing responses', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const provider = new OpenAiMediaProvider({
      baseUrl: 'https://provider.example.test/v1/',
      apiKey: 'secret-value',
      visionModel: 'vision-snapshot',
      embeddingModel: 'embedding-snapshot',
      dimensions: 3,
      timeoutMs: 1_000,
      failureThreshold: 2,
      cooldownMs: 5_000,
      fetch: async (input, init) => {
        requests.push({ url: String(input), ...(init ? { init } : {}) })
        if (String(input).endsWith('/responses')) {
          return Response.json({
            output_text: JSON.stringify({
              caption: 'A blue bicycle beside a brick wall.',
              tags: ['bicycle', 'blue'],
              ocrText: 'OPEN',
              safety: { category: 'safe' },
            }),
            usage: { input_tokens: 21, output_tokens: 9 },
          })
        }
        return Response.json({
          data: [{ embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 4 },
        })
      },
    })

    const vision = await provider.describeImage({
      bytes: Buffer.from('image'),
      mimeType: 'image/jpeg',
      promptVersion: 'caption-v1',
    })
    const embedding = await provider.embedText({ texts: [vision.caption] })

    assert.equal(vision.caption, 'A blue bicycle beside a brick wall.')
    assert.deepEqual(vision.tags, ['bicycle', 'blue'])
    assert.deepEqual(vision.usage, { inputUnits: 21, outputUnits: 9 })
    assert.deepEqual(embedding.vectors, [[0.1, 0.2, 0.3]])
    const visionBody = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>
    assert.equal(visionBody.store, false)
    assert.equal(requests[0]?.init?.headers instanceof Headers, false)
    assert.match(JSON.stringify(visionBody), /untrusted media content/)
  })

  it('rejects malformed vectors and exposes only stable provider failures', async () => {
    const provider = new OpenAiMediaProvider({
      baseUrl: 'https://provider.example.test/v1',
      apiKey: 'secret-value',
      visionModel: 'vision-snapshot',
      embeddingModel: 'embedding-snapshot',
      dimensions: 3,
      timeoutMs: 1_000,
      failureThreshold: 2,
      cooldownMs: 5_000,
      fetch: async () => Response.json({ data: [{ embedding: [0.1] }] }),
    })

    await assert.rejects(
      provider.embedText({ texts: ['query'] }),
      (error: unknown) => error instanceof AiProviderError && error.code === 'invalid_response',
    )
  })

  it('opens the circuit after consecutive external failures', async () => {
    let now = 100
    const breaker = new CircuitBreaker(2, 50, () => now)
    const fail = async () => {
      throw new Error('provider detail')
    }

    await assert.rejects(breaker.run(fail))
    await assert.rejects(breaker.run(fail))
    assert.equal(breaker.state, 'open')
    await assert.rejects(
      breaker.run(async () => 'never'),
      CircuitOpenError,
    )
    now = 151
    assert.equal(await breaker.run(async () => 'recovered'), 'recovered')
    assert.equal(breaker.state, 'closed')
  })
})
