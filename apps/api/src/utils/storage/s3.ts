import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
  } from '@aws-sdk/client-s3'
  import { Readable } from 'stream'
  import type { StorageProvider } from './types'
  
  interface S3StorageConfig {
    endpoint?: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    bucket: string
    publicUrl?: string
  }
  
  export class S3Storage implements StorageProvider {
    private client: S3Client
    private bucket: string
    private publicBaseUrl: string
  
    constructor(config: S3StorageConfig) {
      this.bucket = config.bucket
      this.client = new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // Required for some S3-compatible providers (R2, MinIO)
        forcePathStyle: !!config.endpoint,
      })
  
      // publicUrl is used to construct the direct asset URL.
      // If not set, fall back to the standard S3 URL format.
      this.publicBaseUrl = config.publicUrl
        ?? `https://${config.bucket}.s3.${config.region}.amazonaws.com`
    }
  
    async write(key: string, buffer: Buffer, mimeType: string): Promise<void> {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }))
    }
  
    async read(key: string): Promise<Buffer | null> {
      try {
        const response = await this.client.send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }))
        if (!response.Body) return null
        // Convert the readable stream to a Buffer
        const chunks: Uint8Array[] = []
        for await (const chunk of response.Body as Readable) {
          chunks.push(chunk)
        }
        return Buffer.concat(chunks)
      } catch {
        return null
      }
    }
  
    async delete(key: string): Promise<void> {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })).catch(() => {})
    }
  
    async exists(key: string): Promise<boolean> {
      try {
        await this.client.send(new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }))
        return true
      } catch {
        return false
      }
    }
  
    publicUrl(key: string): string {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`
    }
  }