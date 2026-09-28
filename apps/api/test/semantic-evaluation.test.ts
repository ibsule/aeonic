import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { evaluationApproved, retrievalMetrics } from '../src/ai/evaluation.js'

interface EvaluationFixture {
  version: string
  cases: Array<{ id: string; modality: string; query: string; expected: string }>
  thresholds: { recallAt10: number; ndcgAt10: number; tenantFilterFailures: number }
}

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

  it('pins representative, privacy, multilingual, and adversarial release cases', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('../evaluation/semantic-search-v1.json', import.meta.url), 'utf8'),
    ) as EvaluationFixture
    assert.equal(fixture.version, 'semantic-retrieval-v1')
    assert.equal(new Set(fixture.cases.map((testCase) => testCase.id)).size, fixture.cases.length)
    assert.ok(fixture.cases.every((testCase) => testCase.query && testCase.expected))
    assert.deepEqual(
      new Set(fixture.cases.map((testCase) => testCase.modality)),
      new Set([
        'image',
        'video-keyframe',
        'pdf-text',
        'office-document',
        'multilingual',
        'adversarial-image',
        'privacy',
        'tenant-isolation',
      ]),
    )
    assert.deepEqual(fixture.thresholds, {
      recallAt10: 0.9,
      ndcgAt10: 0.85,
      tenantFilterFailures: 0,
    })
  })
})
