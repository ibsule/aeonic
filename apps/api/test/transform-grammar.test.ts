import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createTransformPresetSelector,
  parseImageTransformV1,
  parseTransformPresetSelector,
  TransformSpecError,
} from '@aeonic/contracts'

function assertTransformError(specification: string, code: TransformSpecError['code']): void {
  assert.throws(
    () => parseImageTransformV1(specification),
    (error: unknown) => error instanceof TransformSpecError && error.code === code,
  )
}

describe('image transform grammar v1', () => {
  it('round-trips immutable named-preset selectors', () => {
    const selector = createTransformPresetSelector('product-card', 12)
    assert.equal(selector, 'p_product-card.v12')
    assert.deepEqual(parseTransformPresetSelector(selector), { name: 'product-card', version: 12 })
    assert.equal(parseTransformPresetSelector('p_product--card.v12'), null)
    assert.equal(parseTransformPresetSelector('p_product-card.v0'), null)
  })

  it('normalizes ordering, numbers, and defaults into one canonical identity', () => {
    const first = parseImageTransformV1('q_080,f_auto,fit_cover,h_0600,w_0800,g_center')
    const second = parseImageTransformV1('w_800,h_600,f_auto')

    assert.deepEqual(first, second)
    assert.equal(first.canonicalSpec, 'w_800,h_600,f_auto')
    assert.deepEqual(first.plan, {
      grammarVersion: 1,
      autoOrient: true,
      width: 800,
      height: 600,
      fit: 'cover',
      gravity: 'center',
      format: 'auto',
      quality: 80,
    })
  })

  it('retains bounded non-default operations in fixed semantic order', () => {
    const result = parseImageTransformV1(
      'sharpen_01.500,blur_2.000,q_75,g_entropy,f_webp,fit_cover,h_400,w_600',
    )

    assert.equal(result.canonicalSpec, 'w_600,h_400,g_entropy,f_webp,q_75,blur_2,sharpen_1.5')
  })

  it('rejects unknown, duplicate, malformed, and excessive operation sets', () => {
    assertTransformError('w_100,exec_rm', 'unknown_operation')
    assertTransformError('w_100,w_100', 'duplicate_operation')
    assertTransformError('w_100%2Ch_100', 'malformed_operation')
    assertTransformError(
      'a_1,b_1,c_1,d_1,e_1,i_1,j_1,k_1,l_1,m_1,n_1,o_1,p_1',
      'too_many_operations',
    )
    assertTransformError(
      'w_1,h_1,f_png,blur_1,sharpen_1,q_1,fit_cover,g_center,w_2',
      'duplicate_operation',
    )
    assertTransformError(
      'w_1,h_1,f_png,blur_1,sharpen_1,q_1,fit_cover,g_center,w',
      'malformed_operation',
    )
  })

  it('rejects conflicting and ineffective plans', () => {
    assertTransformError('fit_contain,w_100', 'conflicting_operations')
    assertTransformError('w_100,h_100,fit_contain,g_north', 'conflicting_operations')
    assertTransformError('q_75,w_100', 'conflicting_operations')
  })

  it('enforces dimension, pixel, quality, and effect bounds', () => {
    assertTransformError('w_8193', 'invalid_operation_value')
    assertTransformError('w_8000,h_8000', 'output_too_large')
    assertTransformError('f_jpeg,q_101', 'invalid_operation_value')
    assertTransformError('f_png,q_70', 'conflicting_operations')
    assertTransformError('blur_0.2', 'invalid_operation_value')
    assertTransformError('sharpen_10.001', 'invalid_operation_value')
  })
})
