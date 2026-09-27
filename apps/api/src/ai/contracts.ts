export interface ProviderUsage {
  readonly inputUnits: number
  readonly outputUnits: number
}

export interface VisionUnderstandingResult {
  readonly caption: string
  readonly tags: readonly string[]
  readonly ocrText: string | null
  readonly safety: Readonly<Record<string, string>>
  readonly usage: ProviderUsage
}

export interface VisionUnderstandingProvider {
  readonly provider: string
  readonly model: string
  describeImage(input: {
    bytes: Buffer
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
    promptVersion: string
    signal?: AbortSignal
  }): Promise<VisionUnderstandingResult>
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[]
  readonly usage: ProviderUsage
}

export interface EmbeddingProvider {
  readonly provider: string
  readonly model: string
  readonly dimensions: number
  embedText(input: { texts: readonly string[]; signal?: AbortSignal }): Promise<EmbeddingResult>
}

export interface VectorPoint {
  readonly id: string
  readonly vector: readonly number[]
  readonly payload: Readonly<Record<string, string | number | boolean>>
}

export interface VectorSearchHit {
  readonly pointId: string
  readonly score: number
  readonly assetId: string
  readonly assetVersionId: string
}

export interface VectorIndex {
  ensureCollection(collection: string, dimensions: number, signal?: AbortSignal): Promise<void>
  upsert(collection: string, points: readonly VectorPoint[], signal?: AbortSignal): Promise<void>
  search(
    collection: string,
    vector: readonly number[],
    scope: { organizationId: string; projectId: string },
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly VectorSearchHit[]>
  deleteAsset(
    collection: string,
    scope: { organizationId: string; projectId: string },
    assetId: string,
    signal?: AbortSignal,
  ): Promise<void>
  deleteCollection(collection: string, signal?: AbortSignal): Promise<void>
  health(signal?: AbortSignal): Promise<boolean>
}
