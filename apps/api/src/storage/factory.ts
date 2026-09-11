import type { AppConfig } from '../config.js'
import type { StoragePort } from './contracts.js'
import { LocalStorage } from './local-storage.js'
import { S3Storage } from './s3-storage.js'

export interface StorageRuntime {
  readonly backend: 'local' | 's3'
  readonly port: StoragePort
  close(): void
}

export function createStorageRuntime(config: AppConfig): StorageRuntime {
  if (config.storageBackend === 'local') {
    return {
      backend: 'local',
      port: new LocalStorage({ rootDirectory: config.localStoragePath }),
      close: () => undefined,
    }
  }

  const storage = new S3Storage({
    bucket: config.s3Bucket ?? '',
    region: config.s3Region,
    ...(config.s3Endpoint === undefined ? {} : { endpoint: config.s3Endpoint }),
    allowInsecureEndpoint: config.s3AllowInsecureEndpoint,
    forcePathStyle: config.s3ForcePathStyle,
    ...(config.s3AccessKeyId === undefined || config.s3SecretAccessKey === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          },
        }),
    ...(config.s3Prefix === undefined ? {} : { prefix: config.s3Prefix }),
  })
  return { backend: 's3', port: storage, close: () => storage.destroy() }
}
