import type { Readable } from 'node:stream'
import { validate as isUuid } from 'uuid'
import type { TenantScope } from '../repositories/types.js'

declare const storageObjectKeyBrand: unique symbol

export type StorageNamespace = 'temporary' | 'original' | 'derivative'
export type StorageObjectKey = string & { readonly [storageObjectKeyBrand]: true }
export type StorageFailureCode =
  | 'invalid_key'
  | 'invalid_input'
  | 'invalid_range'
  | 'not_found'
  | 'already_exists'
  | 'size_exceeded'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'aborted'
  | 'denied'
  | 'quota_exceeded'
  | 'transient'
  | 'unknown'

export interface StoragePutOptions {
  maxBytes: number
  expectedBytes?: number
  expectedSha256?: string
  signal?: AbortSignal
}

export interface StorageReadOptions {
  range?: { start: number; end: number }
  signal?: AbortSignal
}

export interface StoredObject {
  key: StorageObjectKey
  sizeBytes: number
  sha256: string
}

export interface StoredObjectMetadata {
  key: StorageObjectKey
  sizeBytes: number
  modifiedAt: Date
  sha256?: string
}

export interface StorageCapacity {
  totalBytes: bigint
  availableBytes: bigint
}

export interface StorageHealth {
  status: 'available' | 'degraded' | 'unavailable'
  writable: boolean
  capacity: StorageCapacity | null
}

export interface StoragePort {
  initialize(): Promise<void>
  put(
    scope: TenantScope,
    key: StorageObjectKey,
    source: Readable,
    options: StoragePutOptions,
  ): Promise<StoredObject>
  open(scope: TenantScope, key: StorageObjectKey, options?: StorageReadOptions): Promise<Readable>
  head(scope: TenantScope, key: StorageObjectKey): Promise<StoredObjectMetadata>
  delete(scope: TenantScope, key: StorageObjectKey): Promise<void>
  health(): Promise<StorageHealth>
}

export class StorageError extends Error {
  override readonly name = 'StorageError'

  constructor(
    readonly code: StorageFailureCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

const namespaces = new Set<StorageNamespace>(['temporary', 'original', 'derivative'])

export function createStorageObjectKey(
  scope: TenantScope,
  namespace: StorageNamespace,
  objectId: string,
): StorageObjectKey {
  if (!isUuid(scope.organizationId) || !isUuid(scope.projectId) || !isUuid(objectId)) {
    throw new StorageError('invalid_key', 'Storage keys require UUID tenant and object IDs.', false)
  }
  const shard = objectId.replaceAll('-', '').slice(0, 4)
  return `${namespace}/${scope.organizationId}/${scope.projectId}/${shard.slice(0, 2)}/${shard.slice(2)}/${objectId}` as StorageObjectKey
}

export function assertStorageObjectKeyScope(scope: TenantScope, key: StorageObjectKey): void {
  const parts = key.split('/')
  if (
    parts.length !== 6 ||
    !namespaces.has(parts[0] as StorageNamespace) ||
    parts[1] !== scope.organizationId ||
    parts[2] !== scope.projectId ||
    !/^[0-9a-f]{2}$/.test(parts[3] ?? '') ||
    !/^[0-9a-f]{2}$/.test(parts[4] ?? '') ||
    !isUuid(parts[5] ?? '') ||
    (parts[5] ?? '').replaceAll('-', '').slice(0, 4) !== `${parts[3]}${parts[4]}`
  ) {
    throw new StorageError(
      'invalid_key',
      'Storage object key is invalid or outside its scope.',
      false,
    )
  }
}
