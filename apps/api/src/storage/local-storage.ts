import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open as openFile, realpath, statfs, unlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { type Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TenantScope } from '../repositories/types.js'
import {
  assertStorageObjectKeyScope,
  StorageError,
  type StorageHealth,
  type StorageObjectKey,
  type StoragePort,
  type StoragePutOptions,
  type StorageReadOptions,
  type StoredObject,
  type StoredObjectMetadata,
} from './contracts.js'

const directoryMode = 0o750
const stagingFileMode = 0o600
const noFollow = constants.O_NOFOLLOW ?? 0

function isSafeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function asStorageError(error: unknown, action: string): StorageError {
  if (error instanceof StorageError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new StorageError('aborted', `Storage ${action} was aborted.`, false, { cause: error })
  }

  const code = nodeErrorCode(error)
  if (code === 'ENOENT') {
    return new StorageError('not_found', `Storage object was not found during ${action}.`, false, {
      cause: error,
    })
  }
  if (code === 'EEXIST') {
    return new StorageError(
      'already_exists',
      `Storage object already exists during ${action}.`,
      false,
      {
        cause: error,
      },
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new StorageError('denied', `Storage ${action} was denied.`, false, { cause: error })
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new StorageError(
      'quota_exceeded',
      `Storage capacity was exhausted during ${action}.`,
      true,
      {
        cause: error,
      },
    )
  }
  if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') {
    return new StorageError('invalid_key', `Storage path was unsafe during ${action}.`, false, {
      cause: error,
    })
  }
  if (code === 'EBUSY' || code === 'EINTR' || code === 'EMFILE' || code === 'ENFILE') {
    return new StorageError('transient', `Storage ${action} failed temporarily.`, true, {
      cause: error,
    })
  }
  return new StorageError('unknown', `Storage ${action} failed.`, false, { cause: error })
}

function assertRegularFile(stats: Stats): void {
  if (!stats.isFile()) {
    throw new StorageError('invalid_key', 'Storage object is not a regular file.', false)
  }
}

export interface LocalStorageOptions {
  rootDirectory: string
}

export class LocalStorage implements StoragePort {
  readonly #configuredRoot: string
  #root: string | null = null
  #initialization: Promise<void> | null = null

  constructor(options: LocalStorageOptions) {
    if (options.rootDirectory.trim() === '') {
      throw new StorageError('invalid_input', 'Local storage requires a root directory.', false)
    }
    this.#configuredRoot = resolve(options.rootDirectory)
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initialize()
    return this.#initialization
  }

  async #initialize(): Promise<void> {
    try {
      await mkdir(this.#configuredRoot, { recursive: true, mode: directoryMode })
      const root = await realpath(this.#configuredRoot)
      const stats = await lstat(root)
      if (!stats.isDirectory()) {
        throw new StorageError('invalid_input', 'Local storage root is not a directory.', false)
      }
      this.#root = root
    } catch (error) {
      this.#initialization = null
      throw asStorageError(error, 'initialization')
    }
  }

  async put(
    scope: TenantScope,
    key: StorageObjectKey,
    source: Readable,
    options: StoragePutOptions,
  ): Promise<StoredObject> {
    this.#validatePutOptions(options)
    const targetPath = await this.#objectPath(scope, key, true)
    const parentPath = dirname(targetPath)
    const stagingPath = resolve(parentPath, `.stage-${randomUUID()}`)
    let stagingHandle: Awaited<ReturnType<typeof openFile>> | null = null

    try {
      stagingHandle = await openFile(
        stagingPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        stagingFileMode,
      )
      const writableHandle = stagingHandle
      const hash = createHash('sha256')
      let sizeBytes = 0
      let writePosition = 0
      const counter = new Transform({
        transform(chunk: Buffer | string, encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          sizeBytes += bytes.byteLength
          if (sizeBytes > options.maxBytes) {
            callback(
              new StorageError('size_exceeded', 'Storage object exceeds its size limit.', false),
            )
            return
          }
          hash.update(bytes)
          callback(null, bytes)
        },
      })
      const sink = new Writable({
        write(chunk: Buffer | string, encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          void (async () => {
            let offset = 0
            while (offset < bytes.byteLength) {
              const result = await writableHandle.write(
                bytes,
                offset,
                bytes.byteLength - offset,
                writePosition,
              )
              if (result.bytesWritten === 0) {
                throw new Error('Storage write made no progress.')
              }
              offset += result.bytesWritten
              writePosition += result.bytesWritten
            }
          })().then(() => callback(), callback)
        },
      })

      await pipeline(source, counter, sink, { signal: options.signal })
      if (options.expectedBytes !== undefined && sizeBytes !== options.expectedBytes) {
        throw new StorageError('size_mismatch', 'Storage object size does not match.', false)
      }
      const sha256 = hash.digest('hex')
      if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
        throw new StorageError(
          'checksum_mismatch',
          'Storage object checksum does not match.',
          false,
        )
      }

      await stagingHandle.sync()
      await stagingHandle.close()
      stagingHandle = null
      await link(stagingPath, targetPath)
      await unlink(stagingPath)
      await this.#syncDirectory(parentPath)
      return { key, sizeBytes, sha256 }
    } catch (error) {
      if (stagingHandle !== null) await stagingHandle.close().catch(() => undefined)
      await unlink(stagingPath).catch(() => undefined)
      throw asStorageError(error, 'write')
    }
  }

  async open(
    scope: TenantScope,
    key: StorageObjectKey,
    options: StorageReadOptions = {},
  ): Promise<Readable> {
    const targetPath = await this.#objectPath(scope, key, false)
    let handle: Awaited<ReturnType<typeof openFile>> | null = null
    try {
      options.signal?.throwIfAborted()
      handle = await openFile(targetPath, constants.O_RDONLY | noFollow)
      const stats = await handle.stat()
      assertRegularFile(stats)
      const range = options.range
      if (
        range !== undefined &&
        (!isSafeByteCount(range.start) ||
          !isSafeByteCount(range.end) ||
          range.start > range.end ||
          range.end >= stats.size)
      ) {
        throw new StorageError('invalid_range', 'Storage byte range is invalid.', false)
      }
      const stream = handle.createReadStream({
        autoClose: true,
        ...(range === undefined ? {} : range),
        signal: options.signal,
      })
      handle = null
      return stream
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined)
      throw asStorageError(error, 'read')
    }
  }

  async head(scope: TenantScope, key: StorageObjectKey): Promise<StoredObjectMetadata> {
    const targetPath = await this.#objectPath(scope, key, false)
    let handle: Awaited<ReturnType<typeof openFile>> | null = null
    try {
      handle = await openFile(targetPath, constants.O_RDONLY | noFollow)
      const stats = await handle.stat()
      assertRegularFile(stats)
      return { key, sizeBytes: stats.size, modifiedAt: stats.mtime }
    } catch (error) {
      throw asStorageError(error, 'metadata read')
    } finally {
      if (handle !== null) await handle.close().catch(() => undefined)
    }
  }

  async delete(scope: TenantScope, key: StorageObjectKey): Promise<void> {
    const targetPath = await this.#objectPath(scope, key, false)
    try {
      const stats = await lstat(targetPath)
      assertRegularFile(stats)
      await unlink(targetPath)
      await this.#syncDirectory(dirname(targetPath))
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return
      throw asStorageError(error, 'delete')
    }
  }

  async health(): Promise<StorageHealth> {
    try {
      await this.initialize()
      const root = this.#requireRoot()
      let capacity: StorageHealth['capacity'] = null
      try {
        const stats = await statfs(root, { bigint: true })
        capacity = {
          totalBytes: stats.blocks * stats.bsize,
          availableBytes: stats.bavail * stats.bsize,
        }
      } catch {
        // A write probe still provides a useful degraded health result.
      }

      const probePath = resolve(root, `.health-${randomUUID()}`)
      let probe: Awaited<ReturnType<typeof openFile>> | null = null
      try {
        probe = await openFile(
          probePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
          stagingFileMode,
        )
        await probe.writeFile('ok')
        await probe.sync()
        await probe.close()
        probe = null
        await unlink(probePath)
        await this.#syncDirectory(root)
        return { status: capacity === null ? 'degraded' : 'available', writable: true, capacity }
      } catch {
        if (probe !== null) await probe.close().catch(() => undefined)
        await unlink(probePath).catch(() => undefined)
        return { status: 'degraded', writable: false, capacity }
      }
    } catch {
      return { status: 'unavailable', writable: false, capacity: null }
    }
  }

  #validatePutOptions(options: StoragePutOptions): void {
    if (
      !isSafeByteCount(options.maxBytes) ||
      (options.expectedBytes !== undefined && !isSafeByteCount(options.expectedBytes)) ||
      (options.expectedBytes !== undefined && options.expectedBytes > options.maxBytes) ||
      (options.expectedSha256 !== undefined && !isSha256(options.expectedSha256))
    ) {
      throw new StorageError('invalid_input', 'Storage write options are invalid.', false)
    }
  }

  async #objectPath(
    scope: TenantScope,
    key: StorageObjectKey,
    createParents: boolean,
  ): Promise<string> {
    assertStorageObjectKeyScope(scope, key)
    await this.initialize()
    const root = this.#requireRoot()
    const targetPath = resolve(root, ...key.split('/'))
    if (!targetPath.startsWith(`${root}${sep}`)) {
      throw new StorageError('invalid_key', 'Storage object key escapes its root.', false)
    }
    await this.#verifyParentPath(root, dirname(targetPath), createParents)
    return targetPath
  }

  async #verifyParentPath(root: string, parentPath: string, create: boolean): Promise<void> {
    const segments = relative(root, parentPath).split(sep).filter(Boolean)
    let current = root
    try {
      for (const segment of segments) {
        current = resolve(current, segment)
        if (create) await mkdir(current, { mode: directoryMode }).catch(this.#ignoreExisting)
        const stats = await lstat(current)
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new StorageError('invalid_key', 'Storage path contains an unsafe directory.', false)
        }
      }
      if ((await realpath(parentPath)) !== parentPath) {
        throw new StorageError('invalid_key', 'Storage path contains a symbolic link.', false)
      }
    } catch (error) {
      throw asStorageError(error, 'path validation')
    }
  }

  #ignoreExisting(error: unknown): void {
    if (nodeErrorCode(error) !== 'EEXIST') throw error
  }

  #requireRoot(): string {
    if (this.#root === null) {
      throw new StorageError('unknown', 'Local storage is not initialized.', false)
    }
    return this.#root
  }

  async #syncDirectory(path: string): Promise<void> {
    const handle = await openFile(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
