import { createHash, randomUUID } from 'node:crypto'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  AbortMultipartUploadCommand,
  ChecksumAlgorithm,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
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

const minimumPartSize = 5 * 1024 * 1024
const maximumPartSize = 5 * 1024 * 1024 * 1024
const maximumParts = 10_000
const emptySha256Hex = createHash('sha256').digest('hex')
const emptySha256Base64 = Buffer.from(emptySha256Hex, 'hex').toString('base64')

interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface S3StorageOptions {
  bucket: string
  region: string
  endpoint?: string
  allowInsecureEndpoint?: boolean
  forcePathStyle?: boolean
  credentials?: S3Credentials
  prefix?: string
  expectedBucketOwner?: string
  maxAttempts?: number
  multipartPartSizeBytes?: number
  multipartConcurrency?: number
  serverSideEncryption?: ServerSideEncryption
  kmsKeyId?: string
}

interface IntegrityResult {
  sizeBytes: number
  sha256: string
}

class IntegrityTransform extends Transform {
  readonly #hash = createHash('sha256')
  readonly #options: StoragePutOptions
  #sizeBytes = 0
  #completed = false

  constructor(options: StoragePutOptions) {
    super()
    this.#options = options
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.#sizeBytes += bytes.byteLength
    if (this.#sizeBytes > this.#options.maxBytes) {
      callback(new StorageError('size_exceeded', 'Storage object exceeds its size limit.', false))
      return
    }
    this.#hash.update(bytes)
    callback(null, bytes)
  }

  complete(): IntegrityResult {
    if (this.#completed) {
      throw new StorageError(
        'unknown',
        'Storage integrity calculation was already completed.',
        false,
      )
    }
    this.#completed = true
    if (
      this.#options.expectedBytes !== undefined &&
      this.#sizeBytes !== this.#options.expectedBytes
    ) {
      throw new StorageError('size_mismatch', 'Storage object size does not match.', false)
    }
    const sha256 = this.#hash.digest('hex')
    if (this.#options.expectedSha256 !== undefined && sha256 !== this.#options.expectedSha256) {
      throw new StorageError('checksum_mismatch', 'Storage object checksum does not match.', false)
    }
    return { sizeBytes: this.#sizeBytes, sha256 }
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function httpStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('$metadata' in error)) return undefined
  const metadata = error.$metadata as { httpStatusCode?: unknown }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined
}

function errorName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return error.name || nodeErrorCode(error)
}

function findStorageError(error: unknown): StorageError | null {
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof StorageError) return current
    current = current.cause
  }
  return null
}

function asStorageError(error: unknown, action: string): StorageError {
  const storageError = findStorageError(error)
  if (storageError !== null) return storageError
  if (error instanceof Error && error.name === 'AbortError') {
    return new StorageError('aborted', `S3 ${action} was aborted.`, false, { cause: error })
  }

  const name = errorName(error)
  const status = httpStatus(error)
  if (status === 404 || name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchBucket') {
    return new StorageError('not_found', `S3 resource was not found during ${action}.`, false, {
      cause: error,
    })
  }
  if (status === 412 || name === 'PreconditionFailed') {
    return new StorageError('already_exists', `S3 object already exists during ${action}.`, false, {
      cause: error,
    })
  }
  if (status === 416 || name === 'InvalidRange') {
    return new StorageError('invalid_range', `S3 byte range is invalid during ${action}.`, false, {
      cause: error,
    })
  }
  if (
    status === 401 ||
    status === 403 ||
    name === 'AccessDenied' ||
    name === 'InvalidAccessKeyId'
  ) {
    return new StorageError('denied', `S3 ${action} was denied.`, false, { cause: error })
  }
  if (name === 'BadDigest' || name === 'ChecksumMismatch') {
    return new StorageError(
      'checksum_mismatch',
      `S3 checksum validation failed during ${action}.`,
      false,
      {
        cause: error,
      },
    )
  }
  if (status === 507 || name === 'QuotaExceeded' || name === 'InsufficientStorage') {
    return new StorageError('quota_exceeded', `S3 capacity was exhausted during ${action}.`, true, {
      cause: error,
    })
  }
  if (status === 413 || name === 'EntityTooLarge') {
    return new StorageError('size_exceeded', `S3 object was too large during ${action}.`, false, {
      cause: error,
    })
  }
  if (
    (status !== undefined && (status === 408 || status === 429 || status >= 500)) ||
    name === 'SlowDown' ||
    name === 'ConditionalRequestConflict' ||
    name === 'RequestTimeout' ||
    name === 'TimeoutError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(
      nodeErrorCode(error) ?? '',
    )
  ) {
    return new StorageError('transient', `S3 ${action} failed temporarily.`, true, { cause: error })
  }
  return new StorageError('unknown', `S3 ${action} failed.`, false, { cause: error })
}

function isSafeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function normalizePrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return ''
  const normalized = prefix.replace(/^\/+|\/+$/g, '')
  if (
    normalized === '' ||
    normalized.includes('\\') ||
    normalized
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacter(normalized)
  ) {
    throw new StorageError('invalid_input', 'S3 storage prefix is invalid.', false)
  }
  return `${normalized}/`
}

function validateOptions(options: S3StorageOptions): void {
  if (
    options.bucket.trim() === '' ||
    options.bucket !== options.bucket.trim() ||
    options.region.trim() === '' ||
    options.region !== options.region.trim()
  ) {
    throw new StorageError('invalid_input', 'S3 storage requires a bucket and region.', false)
  }
  if (hasControlCharacter(options.bucket)) {
    throw new StorageError('invalid_input', 'S3 bucket is invalid.', false)
  }
  if (options.endpoint !== undefined) {
    let endpoint: URL
    try {
      endpoint = new URL(options.endpoint)
    } catch (error) {
      throw new StorageError('invalid_input', 'S3 endpoint is invalid.', false, { cause: error })
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new StorageError('invalid_input', 'S3 endpoint must use HTTP or HTTPS.', false)
    }
    if (
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      endpoint.search !== '' ||
      endpoint.hash !== ''
    ) {
      throw new StorageError(
        'invalid_input',
        'S3 endpoint must not contain credentials, a query, or a fragment.',
        false,
      )
    }
    if (endpoint.protocol !== 'https:' && options.allowInsecureEndpoint !== true) {
      throw new StorageError(
        'invalid_input',
        'Insecure S3 endpoints require explicit operator approval.',
        false,
      )
    }
  }
  if (options.kmsKeyId !== undefined && options.serverSideEncryption !== 'aws:kms') {
    throw new StorageError('invalid_input', 'An S3 KMS key requires aws:kms encryption.', false)
  }
  if (
    options.credentials !== undefined &&
    (options.credentials.accessKeyId === '' || options.credentials.secretAccessKey === '')
  ) {
    throw new StorageError('invalid_input', 'S3 credentials must not be empty.', false)
  }
  if (
    options.maxAttempts !== undefined &&
    (!Number.isSafeInteger(options.maxAttempts) ||
      options.maxAttempts < 1 ||
      options.maxAttempts > 10)
  ) {
    throw new StorageError('invalid_input', 'S3 retry attempts must be between 1 and 10.', false)
  }
}

async function* chunkParts(source: Readable, partSize: number): AsyncGenerator<Buffer> {
  let chunks: Buffer[] = []
  let bufferedBytes = 0
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let offset = 0
    while (offset < bytes.byteLength) {
      const length = Math.min(partSize - bufferedBytes, bytes.byteLength - offset)
      chunks.push(bytes.subarray(offset, offset + length))
      bufferedBytes += length
      offset += length
      if (bufferedBytes === partSize) {
        yield Buffer.concat(chunks, bufferedBytes)
        chunks = []
        bufferedBytes = 0
      }
    }
  }
  if (bufferedBytes > 0) yield Buffer.concat(chunks, bufferedBytes)
}

export class S3Storage implements StoragePort {
  readonly #bucket: string
  readonly #prefix: string
  readonly #expectedBucketOwner: string | undefined
  readonly #partSize: number
  readonly #concurrency: number
  readonly #serverSideEncryption: ServerSideEncryption | undefined
  readonly #kmsKeyId: string | undefined
  readonly #client: S3Client
  #initialization: Promise<void> | null = null

  constructor(options: S3StorageOptions) {
    validateOptions(options)
    this.#bucket = options.bucket
    this.#prefix = normalizePrefix(options.prefix)
    this.#expectedBucketOwner = options.expectedBucketOwner
    this.#partSize = options.multipartPartSizeBytes ?? 8 * 1024 * 1024
    this.#concurrency = options.multipartConcurrency ?? 3
    if (
      !Number.isSafeInteger(this.#partSize) ||
      this.#partSize < minimumPartSize ||
      this.#partSize > maximumPartSize
    ) {
      throw new StorageError(
        'invalid_input',
        'S3 multipart part size must be between 5 MiB and 5 GiB.',
        false,
      )
    }
    if (
      !Number.isSafeInteger(this.#concurrency) ||
      this.#concurrency < 1 ||
      this.#concurrency > 16
    ) {
      throw new StorageError(
        'invalid_input',
        'S3 multipart concurrency must be between 1 and 16.',
        false,
      )
    }
    this.#serverSideEncryption = options.serverSideEncryption
    this.#kmsKeyId = options.kmsKeyId

    const clientConfig: S3ClientConfig = {
      region: options.region,
      maxAttempts: options.maxAttempts ?? 3,
      forcePathStyle: options.forcePathStyle ?? false,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    }
    this.#client = new S3Client(clientConfig)
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initialize()
    return this.#initialization
  }

  async #initialize(): Promise<void> {
    try {
      await this.#client.send(
        new HeadBucketCommand({
          Bucket: this.#bucket,
          ExpectedBucketOwner: this.#expectedBucketOwner,
        }),
      )
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
    await this.initialize()
    const objectKey = this.#objectKey(scope, key)
    let uploadId: string | undefined
    const operationAbort = new AbortController()
    const signal =
      options.signal === undefined
        ? operationAbort.signal
        : AbortSignal.any([options.signal, operationAbort.signal])

    try {
      const created = await this.#client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
          ExpectedBucketOwner: this.#expectedBucketOwner,
          ServerSideEncryption: this.#serverSideEncryption,
          SSEKMSKeyId: this.#kmsKeyId,
          Metadata:
            options.expectedSha256 === undefined ? undefined : { sha256: options.expectedSha256 },
        }),
        { abortSignal: signal },
      )
      uploadId = created.UploadId
      if (uploadId === undefined) {
        throw new StorageError('unknown', 'S3 did not return a multipart upload ID.', false)
      }

      const integrity = new IntegrityTransform(options)
      const validation = pipeline(source, integrity, { signal })
      const parts = chunkParts(integrity, this.#partSize)
      const completedParts: Array<{
        ETag: string
        PartNumber: number
        ChecksumSHA256: string
      }> = []
      let nextPartNumber = 1

      const worker = async (): Promise<void> => {
        for (;;) {
          const part = await parts.next()
          if (part.done) return
          const partNumber = nextPartNumber
          nextPartNumber += 1
          const checksum = createHash('sha256').update(part.value).digest('base64')
          const uploaded = await this.#client.send(
            new UploadPartCommand({
              Bucket: this.#bucket,
              Key: objectKey,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: part.value,
              ContentLength: part.value.byteLength,
              ChecksumSHA256: checksum,
              ExpectedBucketOwner: this.#expectedBucketOwner,
            }),
            { abortSignal: signal },
          )
          if (uploaded.ETag === undefined) {
            throw new StorageError(
              'unknown',
              `S3 did not return an ETag for part ${partNumber}.`,
              false,
            )
          }
          completedParts[partNumber - 1] = {
            ETag: uploaded.ETag,
            PartNumber: partNumber,
            ChecksumSHA256: uploaded.ChecksumSHA256 ?? checksum,
          }
        }
      }

      try {
        await Promise.all(Array.from({ length: this.#concurrency }, worker))
        await validation
      } catch (error) {
        operationAbort.abort(error)
        await validation.catch(() => undefined)
        throw error
      }
      const result = integrity.complete()

      if (completedParts.length === 0) {
        await this.#abortMultipart(objectKey, uploadId)
        uploadId = undefined
        await this.#client.send(
          new PutObjectCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            Body: Buffer.alloc(0),
            ContentLength: 0,
            ChecksumSHA256: emptySha256Base64,
            IfNoneMatch: '*',
            ExpectedBucketOwner: this.#expectedBucketOwner,
            ServerSideEncryption: this.#serverSideEncryption,
            SSEKMSKeyId: this.#kmsKeyId,
            Metadata: { sha256: emptySha256Hex },
          }),
          { abortSignal: signal },
        )
      } else {
        await this.#client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: objectKey,
            UploadId: uploadId,
            MultipartUpload: { Parts: completedParts },
            IfNoneMatch: '*',
            ExpectedBucketOwner: this.#expectedBucketOwner,
          }),
          { abortSignal: signal },
        )
        uploadId = undefined
      }
      return { key, ...result }
    } catch (error) {
      operationAbort.abort(error)
      source.destroy(error instanceof Error ? error : undefined)
      if (uploadId !== undefined) await this.#abortMultipart(objectKey, uploadId)
      throw asStorageError(error, 'write')
    }
  }

  async open(
    scope: TenantScope,
    key: StorageObjectKey,
    options: StorageReadOptions = {},
  ): Promise<Readable> {
    await this.initialize()
    const objectKey = this.#objectKey(scope, key)
    try {
      let range: string | undefined
      if (options.range !== undefined) {
        const metadata = await this.head(scope, key)
        const { start, end } = options.range
        if (
          !isSafeByteCount(start) ||
          !isSafeByteCount(end) ||
          start > end ||
          end >= metadata.sizeBytes
        ) {
          throw new StorageError('invalid_range', 'Storage byte range is invalid.', false)
        }
        range = `bytes=${start}-${end}`
      }
      const command = new GetObjectCommand({
        Bucket: this.#bucket,
        Key: objectKey,
        Range: range,
        ExpectedBucketOwner: this.#expectedBucketOwner,
      })
      const response =
        options.signal === undefined
          ? await this.#client.send(command)
          : await this.#client.send(command, { abortSignal: options.signal })
      const body = response.Body
      if (body === undefined || typeof (body as NodeJS.ReadableStream).pipe !== 'function') {
        throw new StorageError('unknown', 'S3 returned a non-streaming object body.', false)
      }
      return body as Readable
    } catch (error) {
      throw asStorageError(error, 'read')
    }
  }

  async head(scope: TenantScope, key: StorageObjectKey): Promise<StoredObjectMetadata> {
    await this.initialize()
    const objectKey = this.#objectKey(scope, key)
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ExpectedBucketOwner: this.#expectedBucketOwner,
        }),
      )
      if (response.ContentLength === undefined || response.LastModified === undefined) {
        throw new StorageError('unknown', 'S3 returned incomplete object metadata.', false)
      }
      const sha256 = response.Metadata?.sha256
      return {
        key,
        sizeBytes: response.ContentLength,
        modifiedAt: response.LastModified,
        ...(sha256 !== undefined && isSha256(sha256) ? { sha256 } : {}),
      }
    } catch (error) {
      throw asStorageError(error, 'metadata read')
    }
  }

  async delete(scope: TenantScope, key: StorageObjectKey): Promise<void> {
    await this.initialize()
    const objectKey = this.#objectKey(scope, key)
    try {
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: objectKey,
          ExpectedBucketOwner: this.#expectedBucketOwner,
        }),
      )
    } catch (error) {
      if (asStorageError(error, 'delete').code === 'not_found') return
      throw asStorageError(error, 'delete')
    }
  }

  async health(): Promise<StorageHealth> {
    try {
      await this.initialize()
    } catch {
      return { status: 'unavailable', writable: false, capacity: null }
    }

    const key = `${this.#prefix}temporary/.health/${randomUUID()}`
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: Buffer.alloc(0),
          ContentLength: 0,
          ChecksumSHA256: emptySha256Base64,
          IfNoneMatch: '*',
          ExpectedBucketOwner: this.#expectedBucketOwner,
          ServerSideEncryption: this.#serverSideEncryption,
          SSEKMSKeyId: this.#kmsKeyId,
        }),
      )
      await this.#client.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ExpectedBucketOwner: this.#expectedBucketOwner,
        }),
      )
      return { status: 'available', writable: true, capacity: null }
    } catch {
      await this.#client
        .send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            ExpectedBucketOwner: this.#expectedBucketOwner,
          }),
        )
        .catch(() => undefined)
      return { status: 'degraded', writable: false, capacity: null }
    }
  }

  destroy(): void {
    this.#client.destroy()
  }

  #objectKey(scope: TenantScope, key: StorageObjectKey): string {
    assertStorageObjectKeyScope(scope, key)
    return `${this.#prefix}${key}`
  }

  #validatePutOptions(options: StoragePutOptions): void {
    if (
      !isSafeByteCount(options.maxBytes) ||
      options.maxBytes > this.#partSize * maximumParts ||
      (options.expectedBytes !== undefined && !isSafeByteCount(options.expectedBytes)) ||
      (options.expectedBytes !== undefined && options.expectedBytes > options.maxBytes) ||
      (options.expectedSha256 !== undefined && !isSha256(options.expectedSha256))
    ) {
      throw new StorageError('invalid_input', 'Storage write options are invalid.', false)
    }
  }

  async #abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.#client
      .send(
        new AbortMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          ExpectedBucketOwner: this.#expectedBucketOwner,
        }),
      )
      .catch(() => undefined)
  }
}
