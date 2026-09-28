export interface EvaluationQueryResult {
  readonly expectedAssetIds: readonly string[]
  readonly returnedAssetIds: readonly string[]
}

export interface RetrievalMetrics {
  readonly recallAt10: number
  readonly ndcgAt10: number
}

export const SEMANTIC_EVALUATION_VERSION = 'semantic-retrieval-v1'
export const MINIMUM_RECALL_AT_10 = 0.9
export const MINIMUM_NDCG_AT_10 = 0.85

export function retrievalMetrics(results: readonly EvaluationQueryResult[]): RetrievalMetrics {
  if (results.length === 0) return { recallAt10: 0, ndcgAt10: 0 }
  let recall = 0
  let ndcg = 0
  for (const result of results) {
    const expected = new Set(result.expectedAssetIds)
    if (expected.size === 0) continue
    const returned = result.returnedAssetIds.slice(0, 10)
    const matches = returned.filter((assetId) => expected.has(assetId)).length
    recall += matches / expected.size
    let dcg = 0
    returned.forEach((assetId, index) => {
      if (expected.has(assetId)) dcg += 1 / Math.log2(index + 2)
    })
    let ideal = 0
    for (let index = 0; index < Math.min(expected.size, 10); index += 1) {
      ideal += 1 / Math.log2(index + 2)
    }
    ndcg += ideal === 0 ? 0 : dcg / ideal
  }
  return { recallAt10: recall / results.length, ndcgAt10: ndcg / results.length }
}

export function evaluationApproved(
  metrics: RetrievalMetrics,
  tenantFilterFailures: number,
): boolean {
  return (
    metrics.recallAt10 >= MINIMUM_RECALL_AT_10 &&
    metrics.ndcgAt10 >= MINIMUM_NDCG_AT_10 &&
    tenantFilterFailures === 0
  )
}
