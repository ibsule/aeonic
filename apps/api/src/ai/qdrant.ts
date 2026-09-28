import { CircuitBreaker } from './circuit-breaker.js'
import type { VectorIndex, VectorPoint, VectorSearchHit } from './contracts.js'

type Fetch = typeof fetch

export class VectorIndexError extends Error {
  override readonly name = 'VectorIndexError'

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface QdrantOptions {
  readonly baseUrl: string
  readonly apiKey?: string
  readonly timeoutMs: number
  readonly failureThreshold: number
  readonly cooldownMs: number
  readonly fetch?: Fetch
}

function collectionName(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError('Qdrant collection names must be stable lowercase identifiers.')
  }
}

export class QdrantVectorIndex implements VectorIndex {
  readonly #baseUrl: string
  readonly #apiKey: string | undefined
  readonly #timeoutMs: number
  readonly #fetch: Fetch
  readonly #breaker: CircuitBreaker

  constructor(options: QdrantOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#apiKey = options.apiKey
    this.#timeoutMs = options.timeoutMs
    this.#fetch = options.fetch ?? fetch
    this.#breaker = new CircuitBreaker(options.failureThreshold, options.cooldownMs)
  }

  async ensureCollection(
    collection: string,
    dimensions: number,
    signal?: AbortSignal,
  ): Promise<void> {
    collectionName(collection)
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 65_536) {
      throw new TypeError('Vector dimensions must be an integer from 1 to 65,536.')
    }
    const existing = await this.raw(`/collections/${collection}`, { method: 'GET' }, signal, [404])
    if (existing.status === 404) {
      await this.json(
        `/collections/${collection}`,
        {
          method: 'PUT',
          body: {
            vectors: { size: dimensions, distance: 'Cosine', on_disk: true },
            hnsw_config: { m: 0, payload_m: 16 },
            strict_mode_config: { enabled: true },
          },
        },
        signal,
      )
      for (const field of ['organization_id', 'project_id', 'asset_id', 'asset_version_id']) {
        await this.json(
          `/collections/${collection}/index?wait=true`,
          {
            method: 'PUT',
            body: {
              field_name: field,
              field_schema:
                field === 'project_id' ? { type: 'keyword', is_tenant: true } : 'keyword',
            },
          },
          signal,
        )
      }
      return
    }
    const size =
      existing.body.result && typeof existing.body.result === 'object'
        ? (
            (
              (existing.body.result as Record<string, unknown>).config as
                | Record<string, unknown>
                | undefined
            )?.params as Record<string, unknown> | undefined
          )?.vectors
        : null
    const existingSize =
      size && typeof size === 'object' ? (size as Record<string, unknown>).size : undefined
    if (existingSize !== dimensions) {
      throw new VectorIndexError(
        'The existing Qdrant collection has incompatible dimensions.',
        false,
      )
    }
  }

  async upsert(
    collection: string,
    points: readonly VectorPoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    collectionName(collection)
    if (points.length < 1 || points.length > 256) {
      throw new TypeError('Vector upserts must contain 1 to 256 points.')
    }
    await this.json(
      `/collections/${collection}/points?wait=true`,
      { method: 'PUT', body: { points } },
      signal,
    )
  }

  async search(
    collection: string,
    vector: readonly number[],
    scope: { organizationId: string; projectId: string },
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchHit[]> {
    collectionName(collection)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Vector search limits must be between 1 and 100.')
    }
    const result = await this.json(
      `/collections/${collection}/points/query`,
      {
        method: 'POST',
        body: {
          query: vector,
          filter: {
            must: [
              { key: 'organization_id', match: { value: scope.organizationId } },
              { key: 'project_id', match: { value: scope.projectId } },
            ],
          },
          limit,
          with_payload: true,
        },
      },
      signal,
    )
    const points =
      result.result && typeof result.result === 'object'
        ? (result.result as Record<string, unknown>).points
        : null
    if (!Array.isArray(points)) {
      throw new VectorIndexError('Qdrant returned an invalid query response.', true)
    }
    return points.flatMap((point): VectorSearchHit[] => {
      if (!point || typeof point !== 'object') return []
      const item = point as Record<string, unknown>
      const payload = item.payload
      if (!payload || typeof payload !== 'object') return []
      const values = payload as Record<string, unknown>
      if (
        typeof item.id !== 'string' ||
        typeof item.score !== 'number' ||
        typeof values.asset_id !== 'string' ||
        typeof values.asset_version_id !== 'string'
      ) {
        return []
      }
      return [
        {
          pointId: item.id,
          score: item.score,
          assetId: values.asset_id,
          assetVersionId: values.asset_version_id,
        },
      ]
    })
  }

  async deleteAsset(
    collection: string,
    scope: { organizationId: string; projectId: string },
    assetId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    collectionName(collection)
    await this.json(
      `/collections/${collection}/points/delete?wait=true`,
      {
        method: 'POST',
        body: {
          filter: {
            must: [
              { key: 'organization_id', match: { value: scope.organizationId } },
              { key: 'project_id', match: { value: scope.projectId } },
              { key: 'asset_id', match: { value: assetId } },
            ],
          },
        },
      },
      signal,
    )
  }

  async deleteCollection(collection: string, signal?: AbortSignal): Promise<void> {
    collectionName(collection)
    await this.raw(`/collections/${collection}`, { method: 'DELETE' }, signal, [404])
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.json('/readyz', { method: 'GET' }, signal)
      return true
    } catch {
      return false
    }
  }

  private async json(
    path: string,
    options: { method: string; body?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return (await this.raw(path, options, signal)).body
  }

  private async raw(
    path: string,
    options: { method: string; body?: Record<string, unknown> },
    signal?: AbortSignal,
    acceptedStatuses: readonly number[] = [],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return this.#breaker.run(async () => {
      const timeout = AbortSignal.timeout(this.#timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      let response: Response
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: options.method,
          headers: {
            ...(this.#apiKey ? { 'api-key': this.#apiKey } : {}),
            ...(options.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          signal: combined,
        })
      } catch (error) {
        throw new VectorIndexError('Qdrant is unavailable.', true, { cause: error })
      }
      if (!response.ok && !acceptedStatuses.includes(response.status)) {
        throw new VectorIndexError(
          `Qdrant returned HTTP ${response.status}.`,
          response.status === 408 ||
            response.status === 409 ||
            response.status === 429 ||
            response.status >= 500,
        )
      }
      let body: unknown = {}
      try {
        body = await response.json()
      } catch {
        if (response.status !== 404) {
          throw new VectorIndexError('Qdrant returned invalid JSON.', true)
        }
      }
      return {
        status: response.status,
        body: body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
      }
    })
  }
}
