import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Readable, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface StagedMediaInput {
  readonly directory: string
  readonly path: string
  cleanup(): Promise<void>
}

export async function stageMediaInput(
  source: Readable,
  extension: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StagedMediaInput> {
  if (!/^[a-z0-9]{1,8}$/.test(extension) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    source.destroy()
    throw new TypeError('Staged media input options are invalid.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'aeonic-media-'))
  const path = join(directory, `input.${extension}`)
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      received += content.byteLength
      callback(
        received > maxBytes
          ? new RangeError('Media input exceeds its configured byte limit.')
          : null,
        content,
      )
    },
  })
  try {
    await pipeline(source, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
      signal,
    })
    return {
      directory,
      path,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function assertOutputSize(path: string, maxBytes: number): Promise<number> {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new RangeError('Media output exceeds its configured byte limit.')
  }
  return metadata.size
}
