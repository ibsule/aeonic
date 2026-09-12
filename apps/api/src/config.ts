import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1_024).max(10_485_760).default(1_048_576),
  DATABASE_PATH: z.string().trim().min(1).default('data/aeonic.db'),
  DATABASE_BUSY_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  DATABASE_WAL_AUTOCHECKPOINT_PAGES: z.coerce.number().int().min(1).max(100_000).default(1_000),
  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_PATH: z.string().trim().min(1).default('data/objects'),
  S3_BUCKET: z.string().trim().min(1).optional(),
  S3_REGION: z.string().trim().min(1).default('us-east-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_ALLOW_INSECURE_ENDPOINT: z.enum(['true', 'false']).default('false'),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_PREFIX: z.string().optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(5_368_709_120).default(104_857_600),
  TUS_STORAGE_PATH: z.string().trim().min(1).default('data/tus'),
  TUS_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(5_368_709_120)
    .default(5_368_709_120),
  TUS_UPLOAD_EXPIRATION_MS: z.coerce
    .number()
    .int()
    .min(3_600_000)
    .max(604_800_000)
    .default(86_400_000),
  PROJECT_STORAGE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(Number.MAX_SAFE_INTEGER)
    .default(10_737_418_240),
  UPLOAD_STALE_AFTER_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  WORKER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  WORKER_JOB_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(1_800_000).default(120_000),
  IMAGE_MAX_INPUT_PIXELS: z.coerce
    .number()
    .int()
    .min(1_000_000)
    .max(500_000_000)
    .default(100_000_000),
  IMAGE_MAX_FRAMES: z.coerce.number().int().min(1).max(1_000).default(100),
  DELIVERY_BASE_URL: z.url().optional(),
  DELIVERY_SIGNING_KEYS: z.string().optional(),
  DELIVERY_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  PUBLIC_DELIVERY_CACHE_SECONDS: z.coerce.number().int().min(0).max(31_536_000).default(31_536_000),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.url().optional(),
  AEONIC_VERSION: z.string().trim().min(1).default('0.4.0'),
})

export interface AppConfig {
  readonly environment: 'development' | 'test' | 'production'
  readonly host: string
  readonly port: number
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  readonly corsOrigins: readonly string[]
  readonly trustProxy: boolean
  readonly requestTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly maxJsonBodyBytes: number
  readonly databasePath: string
  readonly databaseBusyTimeoutMs: number
  readonly databaseWalAutocheckpointPages: number
  readonly storageBackend: 'local' | 's3'
  readonly localStoragePath: string
  readonly s3Bucket?: string
  readonly s3Region: string
  readonly s3Endpoint?: string
  readonly s3AllowInsecureEndpoint: boolean
  readonly s3ForcePathStyle: boolean
  readonly s3AccessKeyId?: string
  readonly s3SecretAccessKey?: string
  readonly s3Prefix?: string
  readonly uploadMaxBytes: number
  readonly tusStoragePath: string
  readonly tusUploadMaxBytes: number
  readonly tusUploadExpirationMs: number
  readonly projectStorageQuotaBytes: number
  readonly uploadStaleAfterMs: number
  readonly workerId?: string
  readonly workerPollMs: number
  readonly workerLeaseMs: number
  readonly workerHeartbeatMs: number
  readonly workerJobTimeoutMs: number
  readonly imageMaxInputPixels: number
  readonly imageMaxFrames: number
  readonly deliveryBaseUrl: string
  readonly deliverySigningKeys: readonly DeliverySigningKey[]
  readonly deliveryUrlTtlSeconds: number
  readonly publicDeliveryCacheSeconds: number
  readonly authSecret: string
  readonly authBaseUrl: string
  readonly version: string
}

export interface DeliverySigningKey {
  readonly id: string
  readonly secret: string
}

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError'
}

function parseOrigins(value: string | undefined, environment: AppConfig['environment']): string[] {
  const origins = value
    ? value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : environment === 'production'
      ? []
      : ['http://localhost:3000']

  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new ConfigurationError(`CORS_ORIGINS contains an invalid origin: ${origin}`)
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new ConfigurationError(
        `CORS_ORIGINS must contain HTTP origins without paths: ${origin}`,
      )
    }
  }

  return origins
}

function parseOrigin(value: string, name: string, environment: AppConfig['environment']): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigurationError(`Invalid configuration: ${name} must be an HTTP origin`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== value ||
    (environment === 'production' && url.protocol !== 'https:')
  ) {
    throw new ConfigurationError(
      `Invalid configuration: ${name} must be an ${environment === 'production' ? 'HTTPS' : 'HTTP'} origin without a path`,
    )
  }
  return value
}

function parseDeliverySigningKeys(
  value: string | undefined,
  environment: AppConfig['environment'],
): DeliverySigningKey[] {
  if (value === undefined) {
    if (environment === 'production') {
      throw new ConfigurationError(
        'Invalid configuration: DELIVERY_SIGNING_KEYS is required in production',
      )
    }
    return [
      {
        id: 'development',
        secret: Buffer.from('development-only-delivery-key-01').toString('base64url'),
      },
    ]
  }

  const keys = value.split(',').map((entry) => {
    const separator = entry.indexOf(':')
    const id = entry.slice(0, separator)
    const secret = entry.slice(separator + 1)
    const decoded = Buffer.from(secret, 'base64url')
    if (
      separator < 1 ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
      !/^[A-Za-z0-9_-]{43,}$/.test(secret) ||
      decoded.byteLength < 32 ||
      decoded.toString('base64url') !== secret
    ) {
      throw new ConfigurationError(
        'Invalid configuration: DELIVERY_SIGNING_KEYS must contain kid:base64url-secret entries with at least 32 secret bytes',
      )
    }
    return { id, secret }
  })
  if (keys.length === 0 || new Set(keys.map((key) => key.id)).size !== keys.length) {
    throw new ConfigurationError(
      'Invalid configuration: DELIVERY_SIGNING_KEYS must contain unique key IDs',
    )
  }
  return keys
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment)

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ')
    throw new ConfigurationError(`Invalid configuration: ${details}`)
  }

  const value = parsed.data
  if (value.STORAGE_BACKEND === 's3' && value.S3_BUCKET === undefined) {
    throw new ConfigurationError('Invalid configuration: S3_BUCKET is required for S3 storage')
  }
  if ((value.S3_ACCESS_KEY_ID === undefined) !== (value.S3_SECRET_ACCESS_KEY === undefined)) {
    throw new ConfigurationError(
      'Invalid configuration: S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together',
    )
  }
  const authSecret = value.BETTER_AUTH_SECRET ?? 'development-only-change-before-production'
  if (value.NODE_ENV === 'production' && value.BETTER_AUTH_SECRET === undefined) {
    throw new ConfigurationError(
      'Invalid configuration: BETTER_AUTH_SECRET is required in production',
    )
  }

  const authBaseUrl = parseOrigin(
    value.BETTER_AUTH_URL ?? `http://localhost:${value.PORT}`,
    'BETTER_AUTH_URL',
    value.NODE_ENV,
  )
  const deliveryBaseUrl = parseOrigin(
    value.DELIVERY_BASE_URL ?? authBaseUrl,
    'DELIVERY_BASE_URL',
    value.NODE_ENV,
  )
  if (value.WORKER_HEARTBEAT_MS * 2 >= value.WORKER_LEASE_MS) {
    throw new ConfigurationError(
      'Invalid configuration: WORKER_HEARTBEAT_MS must be less than half WORKER_LEASE_MS',
    )
  }

  return Object.freeze({
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    corsOrigins: Object.freeze(parseOrigins(value.CORS_ORIGINS, value.NODE_ENV)),
    trustProxy: value.TRUST_PROXY === 'true',
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    maxJsonBodyBytes: value.MAX_JSON_BODY_BYTES,
    databasePath: value.DATABASE_PATH,
    databaseBusyTimeoutMs: value.DATABASE_BUSY_TIMEOUT_MS,
    databaseWalAutocheckpointPages: value.DATABASE_WAL_AUTOCHECKPOINT_PAGES,
    storageBackend: value.STORAGE_BACKEND,
    localStoragePath: value.LOCAL_STORAGE_PATH,
    ...(value.S3_BUCKET === undefined ? {} : { s3Bucket: value.S3_BUCKET }),
    s3Region: value.S3_REGION,
    ...(value.S3_ENDPOINT === undefined ? {} : { s3Endpoint: value.S3_ENDPOINT }),
    s3AllowInsecureEndpoint: value.S3_ALLOW_INSECURE_ENDPOINT === 'true',
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE === 'true',
    ...(value.S3_ACCESS_KEY_ID === undefined ? {} : { s3AccessKeyId: value.S3_ACCESS_KEY_ID }),
    ...(value.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : { s3SecretAccessKey: value.S3_SECRET_ACCESS_KEY }),
    ...(value.S3_PREFIX === undefined ? {} : { s3Prefix: value.S3_PREFIX }),
    uploadMaxBytes: value.UPLOAD_MAX_BYTES,
    tusStoragePath: value.TUS_STORAGE_PATH,
    tusUploadMaxBytes: value.TUS_UPLOAD_MAX_BYTES,
    tusUploadExpirationMs: value.TUS_UPLOAD_EXPIRATION_MS,
    projectStorageQuotaBytes: value.PROJECT_STORAGE_QUOTA_BYTES,
    uploadStaleAfterMs: value.UPLOAD_STALE_AFTER_MS,
    ...(value.WORKER_ID === undefined ? {} : { workerId: value.WORKER_ID }),
    workerPollMs: value.WORKER_POLL_MS,
    workerLeaseMs: value.WORKER_LEASE_MS,
    workerHeartbeatMs: value.WORKER_HEARTBEAT_MS,
    workerJobTimeoutMs: value.WORKER_JOB_TIMEOUT_MS,
    imageMaxInputPixels: value.IMAGE_MAX_INPUT_PIXELS,
    imageMaxFrames: value.IMAGE_MAX_FRAMES,
    deliveryBaseUrl,
    deliverySigningKeys: Object.freeze(
      parseDeliverySigningKeys(value.DELIVERY_SIGNING_KEYS, value.NODE_ENV).map((key) =>
        Object.freeze(key),
      ),
    ),
    deliveryUrlTtlSeconds: value.DELIVERY_URL_TTL_SECONDS,
    publicDeliveryCacheSeconds: value.PUBLIC_DELIVERY_CACHE_SECONDS,
    authSecret,
    authBaseUrl,
    version: value.AEONIC_VERSION,
  })
}
