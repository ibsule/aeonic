import type { AppConfig } from '../config.js'
import type { EmbeddingProvider, VectorIndex, VisionUnderstandingProvider } from './contracts.js'
import { OpenAiMediaProvider } from './openai-provider.js'
import { QdrantVectorIndex } from './qdrant.js'

export interface AiDependencies {
  readonly embeddings?: EmbeddingProvider
  readonly vision?: VisionUnderstandingProvider
  readonly vectors?: VectorIndex
}

export function createAiDependencies(config: AppConfig): AiDependencies {
  if (
    !config.aiEnabled ||
    !config.aiProviderApiKey ||
    !config.aiVisionModel ||
    !config.aiEmbeddingModel
  ) {
    return {}
  }
  const provider = new OpenAiMediaProvider({
    baseUrl: config.aiProviderBaseUrl,
    apiKey: config.aiProviderApiKey,
    visionModel: config.aiVisionModel,
    embeddingModel: config.aiEmbeddingModel,
    dimensions: config.aiEmbeddingDimensions,
    timeoutMs: config.aiProviderTimeoutMs,
    failureThreshold: config.aiProviderFailureThreshold,
    cooldownMs: config.aiProviderCooldownMs,
  })
  return {
    embeddings: provider,
    vision: provider,
    vectors: new QdrantVectorIndex({
      baseUrl: config.qdrantUrl,
      ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
      timeoutMs: config.aiProviderTimeoutMs,
      failureThreshold: config.aiProviderFailureThreshold,
      cooldownMs: config.aiProviderCooldownMs,
    }),
  }
}
