import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QdrantVectorIndex } from '../src/ai/qdrant.js'

describe('Qdrant vector index', () => {
  it('creates strict tenant indexes and applies mandatory search filters', async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
    const qdrant = new QdrantVectorIndex({
      baseUrl: 'http://qdrant.test:6333/',
      apiKey: 'qdrant-secret',
      timeoutMs: 1_000,
      failureThreshold: 2,
      cooldownMs: 5_000,
      fetch: async (input, init) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
          ...(body ? { body } : {}),
        })
        if (String(input).endsWith('/collections/aeonic_index') && init?.method === 'GET') {
          return Response.json({ status: 'not found' }, { status: 404 })
        }
        if (String(input).endsWith('/points/query')) {
          return Response.json({
            result: {
              points: [
                {
                  id: '018f0f70-1111-7777-8888-111111111111',
                  score: 0.91,
                  payload: { asset_id: 'asset-1', asset_version_id: 'version-1' },
                },
              ],
            },
          })
        }
        return Response.json({ result: true })
      },
    })

    await qdrant.ensureCollection('aeonic_index', 3)
    const hits = await qdrant.search(
      'aeonic_index',
      [0.1, 0.2, 0.3],
      { organizationId: 'organization-1', projectId: 'project-1' },
      10,
    )

    const create = requests.find(
      (request) => request.url.endsWith('/collections/aeonic_index') && request.method === 'PUT',
    )
    assert.deepEqual(create?.body, {
      vectors: { size: 3, distance: 'Cosine', on_disk: true },
      hnsw_config: { m: 0, payload_m: 16 },
      strict_mode_config: { enabled: true },
    })
    assert.equal(requests.filter((request) => request.url.includes('/index?wait=true')).length, 4)
    const query = requests.find((request) => request.url.endsWith('/points/query'))?.body
    assert.ok(query)
    assert.deepEqual((query.filter as { must: unknown[] }).must, [
      { key: 'organization_id', match: { value: 'organization-1' } },
      { key: 'project_id', match: { value: 'project-1' } },
    ])
    assert.deepEqual(hits, [
      {
        pointId: '018f0f70-1111-7777-8888-111111111111',
        score: 0.91,
        assetId: 'asset-1',
        assetVersionId: 'version-1',
      },
    ])
  })
})
