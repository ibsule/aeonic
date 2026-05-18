import fs from 'fs/promises'
import path from 'path'
import type { StorageProvider } from './types'

export class LocalStorage implements StorageProvider {
  constructor(private readonly basePath: string) {
    // Ensure the base upload directory exists on startup
    fs.mkdir(basePath, { recursive: true }).catch(() => {
      // Directory already exists — that's fine
    })
  }

  private fullPath(key: string): string {
    // Prevent path traversal attacks: strip any leading slashes or ".." segments
    const safeKey = key.replace(/\.\.\//g, '').replace(/^\/+/, '')
    return path.join(this.basePath, safeKey)
  }

  async write(key: string, buffer: Buffer, _mimeType: string): Promise<void> {
    const filePath = this.fullPath(key)
    // Create subdirectories (e.g. for folder/subfolder/image.jpg)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, buffer)
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.fullPath(key))
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.fullPath(key)).catch(() => {
      // File doesn't exist — nothing to do
    })
  }

  async exists(key: string): Promise<boolean> {
    return fs.access(this.fullPath(key))
      .then(() => true)
      .catch(() => false)
  }

  publicUrl(key: string): string {
    const base = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
    return `${base}/files/${key}`
  }
}