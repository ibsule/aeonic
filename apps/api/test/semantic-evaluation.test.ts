import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluationApproved, retrievalMetrics } from '../src/ai/evaluation.js'

describe('semantic index evaluation', () => {
  it('computes Recall@10 and nDCG@10 with rank sensitivity', () => {
    const metrics = retrievalMetrics([
      { expectedAssetIds: ['a'], returnedAssetIds: ['a', 'b'] },
      { expectedAssetIds: ['c'], returnedAssetIds: ['x', 'c'] },
    ])
    assert.equal(metrics.recallAt10, 1)
    assert.ok(metrics.ndcgAt10 > 0.8 && metrics.ndcgAt10 < 1)
  })

  it('requires quality thresholds and zero tenant-filter failures', () => {
    assert.equal(evaluationApproved({ recallAt10: 0.95, ndcgAt10: 0.9 }, 0), true)
    assert.equal(evaluationApproved({ recallAt10: 0.95, ndcgAt10: 0.9 }, 1), false)
    assert.equal(evaluationApproved({ recallAt10: 0.89, ndcgAt10: 0.9 }, 0), false)
  })
})
