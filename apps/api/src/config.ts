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
  PROJECT_STORAGE_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(Number.MAX_SAFE_INTEGER)
    .default(10_737_418_240),
  UPLOAD_STALE_AFTER_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.url().optional(),
  AEONIC_VERSION: z.string().trim().min(1).default('0.3.0'),
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
  readonly projectStorageQuotaBytes: number
  readonly uploadStaleAfterMs: number
  readonly authSecret: string
  readonly authBaseUrl: string
  readonly version: string
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

  const authBaseUrl = value.BETTER_AUTH_URL ?? `http://localhost:${value.PORT}`
  const parsedAuthBaseUrl = new URL(authBaseUrl)
  if (parsedAuthBaseUrl.origin !== authBaseUrl) {
    throw new ConfigurationError(
      'Invalid configuration: BETTER_AUTH_URL must be an HTTP origin without a path',
    )
  }
  if (value.NODE_ENV === 'production' && parsedAuthBaseUrl.protocol !== 'https:') {
    throw new ConfigurationError(
      'Invalid configuration: BETTER_AUTH_URL must use HTTPS in production',
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
    projectStorageQuotaBytes: value.PROJECT_STORAGE_QUOTA_BYTES,
    uploadStaleAfterMs: value.UPLOAD_STALE_AFTER_MS,
    authSecret,
    authBaseUrl,
    version: value.AEONIC_VERSION,
  })
}
