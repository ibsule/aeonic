import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { v7 as uuidv7 } from 'uuid'
import {
  assertStorageObjectKeyScope,
  createStorageObjectKey,
  type StorageObjectKey,
} from '../src/storage/contracts.js'
import {
  assertAssetTransition,
  assertAssetVersionTransition,
  assertStorageObjectTransition,
  assertUploadTransition,
  InvalidLifecycleTransitionError,
} from '../src/storage/lifecycle.js'

describe('storage contracts', () => {
  it('creates deterministic tenant-scoped object keys', () => {
    const scope = { organizationId: uuidv7(), projectId: uuidv7() }
    const objectId = uuidv7()
    const key = createStorageObjectKey(scope, 'original', objectId)
    const shard = objectId.replaceAll('-', '').slice(0, 4)

    assert.equal(
      key,
      `original/${scope.organizationId}/${scope.projectId}/${shard.slice(0, 2)}/${shard.slice(2)}/${objectId}`,
    )
    assert.doesNotThrow(() => assertStorageObjectKeyScope(scope, key))
  })

  it('rejects cross-tenant and malformed object keys', () => {
    const scope = { organizationId: uuidv7(), projectId: uuidv7() }
    const key = createStorageObjectKey(scope, 'temporary', uuidv7())

    assert.throws(
      () => assertStorageObjectKeyScope({ ...scope, projectId: uuidv7() }, key),
      /outside its scope/,
    )
    assert.throws(
      () => assertStorageObjectKeyScope(scope, '../outside' as StorageObjectKey),
      /invalid or outside/,
    )
  })
})

describe('media lifecycle contracts', () => {
  it('allows the intended happy-path transitions', () => {
    assert.doesNotThrow(() => assertAssetTransition('uploading', 'validating'))
    assert.doesNotThrow(() => assertAssetTransition('validating', 'processing'))
    assert.doesNotThrow(() => assertAssetTransition('processing', 'ready'))
    assert.doesNotThrow(() => assertAssetVersionTransition('validating', 'ready'))
    assert.doesNotThrow(() => assertUploadTransition('receiving', 'validating'))
    assert.doesNotThrow(() => assertUploadTransition('validating', 'completed'))
    assert.doesNotThrow(() => assertStorageObjectTransition('staging', 'available'))
  })

  it('rejects skipped, reversed, and terminal-state transitions', () => {
    for (const transition of [
      () => assertAssetTransition('uploading', 'ready'),
      () => assertAssetVersionTransition('ready', 'processing'),
      () => assertUploadTransition('completed', 'receiving'),
      () => assertStorageObjectTransition('deleted', 'available'),
    ]) {
      assert.throws(transition, InvalidLifecycleTransitionError)
    }
  })
})
