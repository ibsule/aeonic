import path from 'path'
import { LocalStorage } from './local'
import { S3Storage } from './s3'
import type { StorageProvider } from './types'

export type { StorageProvider }

let _storage: StorageProvider | null = null

/**
 * Returns the configured storage provider.
 * Calling this multiple times returns the same instance (singleton).
 *
 * Local disk is used by default — no config needed.
 * Set STORAGE_ENDPOINT (+ credentials) to switch to S3-compatible storage.
 */
export function getStorage(): StorageProvider {
  if (_storage) return _storage

  if (process.env.STORAGE_ENDPOINT || process.env.STORAGE_ACCESS_KEY_ID) {
    // S3-compatible mode
    const required = ['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_BUCKET_NAME']
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(
          `S3 storage is partially configured. Missing environment variable: ${key}. ` +
          `Either set all S3 variables or remove them to use local storage.`
        )
      }
    }

    _storage = new S3Storage({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
      bucket: process.env.STORAGE_BUCKET_NAME!,
      publicUrl: process.env.STORAGE_PUBLIC_URL,
    })

    console.log('✓ Storage: S3-compatible')
  } else {
    // Local disk mode (default)
    const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')
    _storage = new LocalStorage(uploadDir)
    console.log(`✓ Storage: Local disk (${uploadDir})`)
  }

  return _storage
}