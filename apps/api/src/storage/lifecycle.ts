import type {
  AssetState,
  AssetVersionState,
  StorageObjectState,
  UploadState,
} from '../repositories/types.js'

export class InvalidLifecycleTransitionError extends Error {
  override readonly name = 'InvalidLifecycleTransitionError'

  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} lifecycle transition: ${from} -> ${to}`)
  }
}

const assetTransitions: Record<AssetState, readonly AssetState[]> = {
  uploading: ['validating', 'rejected', 'failed'],
  validating: ['processing', 'ready', 'rejected', 'failed'],
  processing: ['ready', 'failed'],
  ready: ['replacing', 'deleting'],
  replacing: ['ready', 'deleting'],
  deleting: ['deleted'],
  deleted: [],
  rejected: ['deleting'],
  failed: ['validating', 'deleting'],
}

const assetVersionTransitions: Record<AssetVersionState, readonly AssetVersionState[]> = {
  uploading: ['validating', 'rejected', 'failed'],
  validating: ['processing', 'ready', 'rejected', 'failed'],
  processing: ['ready', 'failed'],
  ready: [],
  rejected: [],
  failed: [],
}

const uploadTransitions: Record<UploadState, readonly UploadState[]> = {
  created: ['receiving', 'expired', 'terminated'],
  receiving: ['validating', 'failed', 'expired', 'terminated'],
  validating: ['completed', 'rejected', 'failed'],
  completed: [],
  rejected: [],
  failed: ['receiving', 'expired', 'terminated'],
  expired: [],
  terminated: [],
}

const storageObjectTransitions: Record<StorageObjectState, readonly StorageObjectState[]> = {
  staging: ['available', 'failed', 'deleting'],
  available: ['deleting'],
  deleting: ['deleted', 'failed'],
  deleted: [],
  failed: ['deleting'],
}

function assertTransition<T extends string>(
  entity: string,
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): void {
  if (!transitions[from].includes(to)) {
    throw new InvalidLifecycleTransitionError(entity, from, to)
  }
}

export function assertAssetTransition(from: AssetState, to: AssetState): void {
  assertTransition('asset', assetTransitions, from, to)
}

export function assertAssetVersionTransition(from: AssetVersionState, to: AssetVersionState): void {
  assertTransition('asset version', assetVersionTransitions, from, to)
}

export function assertUploadTransition(from: UploadState, to: UploadState): void {
  assertTransition('upload', uploadTransitions, from, to)
}

export function assertStorageObjectTransition(
  from: StorageObjectState,
  to: StorageObjectState,
): void {
  assertTransition('storage object', storageObjectTransitions, from, to)
}
