import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { type FileHandle, mkdir, open, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { validate as isUuid } from 'uuid'
import { StorageError } from '../storage/contracts.js'
import type { TusChecksum } from './tus-protocol.js'

const fileMode = 0o600
const noFollow = constants.O_NOFOLLOW ?? 0

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function asStagingError(error: unknown, action: string): StorageError {
  if (error instanceof StorageError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new StorageError('aborted', `Resumable upload ${action} was aborted.`, true, {
      cause: error,
    })
  }
  const code = nodeErrorCode(error)
  if (code === 'ENOENT') {
    return new StorageError('not_found', `Resumable upload data was not found.`, false, {
      cause: error,
    })
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new StorageError('denied', `Resumable upload ${action} was denied.`, false, {
      cause: error,
    })
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new StorageError(
      'quota_exceeded',
      `Resumable upload staging space is exhausted.`,
      true,
      {
        cause: error,
      },
    )
  }
  return new StorageError('unknown', `Resumable upload ${action} failed.`, false, { cause: error })
}

function assertUploadId(uploadId: string): void {
  if (!isUuid(uploadId)) {
    throw new StorageError('invalid_key', 'Resumable upload identifier is invalid.', false)
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    )
    if (result.bytesWritten === 0) throw new Error('Tus staging write made no progress.')
    written += result.bytesWritten
  }
}

export class TusChecksumMismatchError extends Error {
  override readonly name = 'TusChecksumMismatchError'
}

export class TusOffsetMismatchError extends Error {
  override readonly name = 'TusOffsetMismatchError'
  constructor(readonly actualOffset: number) {
    super('The staged upload offset does not match its durable metadata.')
  }
}

export class TusStagingStore {
  readonly #root: string

  constructor(rootDirectory: string) {
    this.#root = resolve(rootDirectory)
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      const details = await stat(this.#root)
      if (!details.isDirectory()) {
        throw new StorageError('invalid_input', 'Tus staging root is not a directory.', false)
      }
    } catch (error) {
      throw asStagingError(error, 'initialization')
    }
  }

  #path(uploadId: string): string {
    assertUploadId(uploadId)
    return resolve(this.#root, `${uploadId}.upload`)
  }

  async create(uploadId: string): Promise<void> {
    await this.initialize()
    const handle = await open(
      this.#path(uploadId),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      fileMode,
    ).catch((error: unknown) => {
      throw asStagingError(error, 'creation')
    })
    await handle.close()
  }

  async size(uploadId: string): Promise<number> {
    try {
      const handle = await open(this.#path(uploadId), constants.O_RDONLY | noFollow)
      try {
        const details = await handle.stat()
        if (!details.isFile()) {
          throw new StorageError('invalid_key', 'Tus staging object is not a regular file.', false)
        }
        return details.size
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw asStagingError(error, 'metadata read')
    }
  }

  async open(uploadId: string) {
    try {
      const handle = await open(this.#path(uploadId), constants.O_RDONLY | noFollow)
      const details = await handle.stat()
      if (!details.isFile()) {
        await handle.close()
        throw new StorageError('invalid_key', 'Tus staging object is not a regular file.', false)
      }
      return handle.createReadStream({ autoClose: true })
    } catch (error) {
      throw asStagingError(error, 'read')
    }
  }

  async sha256(uploadId: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256')
    const digest = new Writable({
      write(chunk: Buffer | string, encoding, callback) {
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
        callback()
      },
    })
    try {
      await pipeline(await this.open(uploadId), digest, { signal })
      return hash.digest('hex')
    } catch (error) {
      throw asStagingError(error, 'checksum read')
    }
  }

  async append(
    uploadId: string,
    source: NodeJS.ReadableStream,
    options: {
      offset: number
      maxBytes: number
      checksum?: TusChecksum
      signal?: AbortSignal
    },
  ): Promise<number> {
    await this.initialize()
    const chunkPath = resolve(this.#root, `.${uploadId}.${randomUUID()}.chunk`)
    let chunkHandle: Awaited<ReturnType<typeof open>> | null = null
    let written = 0
    const hash = options.checksum ? createHash(options.checksum.algorithm) : null

    try {
      chunkHandle = await open(
        chunkPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        fileMode,
      )
      const writableHandle = chunkHandle
      let chunkPosition = 0
      const counter = new Transform({
        transform(chunk: Buffer | string, encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          written += bytes.byteLength
          if (written > options.maxBytes) {
            callback(
              new StorageError(
                'size_exceeded',
                'Tus chunk exceeds the remaining upload size.',
                false,
              ),
            )
            return
          }
          hash?.update(bytes)
          callback(null, bytes)
        },
      })
      const chunkSink = new Writable({
        write(chunk: Buffer | string, encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
          void writeAll(writableHandle, bytes, chunkPosition)
            .then(() => {
              chunkPosition += bytes.byteLength
            })
            .then(() => callback(), callback)
        },
      })
      await pipeline(source, counter, chunkSink, { signal: options.signal })
      await chunkHandle.sync()
      await chunkHandle.close()
      chunkHandle = null

      if (options.checksum) {
        const actual = hash?.digest()
        if (!actual || !timingSafeEqual(actual, options.checksum.digest)) {
          throw new TusChecksumMismatchError('Tus chunk checksum does not match.')
        }
      }

      const target = await open(this.#path(uploadId), constants.O_RDWR | noFollow)
      try {
        const details = await target.stat()
        if (!details.isFile()) {
          throw new StorageError('invalid_key', 'Tus staging object is not a regular file.', false)
        }
        if (details.size !== options.offset) throw new TusOffsetMismatchError(details.size)
        let position = options.offset
        const sink = new Writable({
          write(chunk: Buffer | string, encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
            void writeAll(target, bytes, position)
              .then(() => {
                position += bytes.byteLength
              })
              .then(() => callback(), callback)
          },
        })
        try {
          await pipeline(createReadStream(chunkPath), sink, { signal: options.signal })
          await target.sync()
        } catch (error) {
          await target.truncate(options.offset)
          await target.sync()
          throw error
        }
      } finally {
        await target.close()
      }
      return written
    } catch (error) {
      if (error instanceof TusChecksumMismatchError || error instanceof TusOffsetMismatchError) {
        throw error
      }
      throw asStagingError(error, 'append')
    } finally {
      if (chunkHandle !== null) await chunkHandle.close().catch(() => undefined)
      await rm(chunkPath, { force: true }).catch(() => undefined)
    }
  }

  async truncate(uploadId: string, size: number): Promise<void> {
    try {
      const handle = await open(this.#path(uploadId), constants.O_RDWR | noFollow)
      try {
        await handle.truncate(size)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw asStagingError(error, 'repair')
    }
  }

  async delete(uploadId: string): Promise<void> {
    await rm(this.#path(uploadId), { force: true }).catch((error: unknown) => {
      throw asStagingError(error, 'deletion')
    })
  }
}
