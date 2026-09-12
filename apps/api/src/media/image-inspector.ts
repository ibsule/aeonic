import type { Readable } from 'node:stream'
import sharp from 'sharp'

export interface ImageInspectionLimits {
  readonly maxInputPixels: number
  readonly maxFrames: number
}

export interface ImageInspection {
  readonly format: 'jpeg' | 'png' | 'gif' | 'webp' | 'avif'
  readonly width: number
  readonly height: number
  readonly frames: number
  readonly orientation: number | null
  readonly hasAlpha: boolean
  readonly colourSpace: string
  readonly channels: number
  readonly depth: string
  readonly density: number | null
  readonly processor: {
    readonly name: 'sharp'
    readonly version: string
    readonly engine: 'libvips'
    readonly engineVersion: string
  }
}

export class ImageInspectionError extends Error {
  override readonly name = 'ImageInspectionError'

  constructor(readonly code: 'invalid_image' | 'image_limit_exceeded' | 'image_type_mismatch') {
    super(
      code === 'invalid_image'
        ? 'The image decoder rejected the input.'
        : code === 'image_limit_exceeded'
          ? 'The image exceeds the configured processing limits.'
          : 'The decoded image format does not match its stored media type.',
    )
  }
}

const formatMimeTypes = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heif: 'image/avif',
} as const

function validateLimits(limits: ImageInspectionLimits): void {
  if (!Number.isSafeInteger(limits.maxInputPixels) || limits.maxInputPixels < 1) {
    throw new TypeError('maxInputPixels must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(limits.maxFrames) || limits.maxFrames < 1) {
    throw new TypeError('maxFrames must be a positive safe integer.')
  }
}

export async function inspectImage(
  source: Readable,
  declaredMimeType: string,
  limits: ImageInspectionLimits,
  signal?: AbortSignal,
): Promise<ImageInspection> {
  validateLimits(limits)
  signal?.throwIfAborted()
  const decoder = sharp({
    animated: true,
    pages: -1,
    sequentialRead: true,
    limitInputPixels: limits.maxInputPixels,
    limitInputChannels: 4,
  })
  const abort = (): void => {
    decoder.destroy(signal?.reason)
  }
  signal?.addEventListener('abort', abort, { once: true })
  source.pipe(decoder)

  try {
    const metadata = await decoder.metadata()
    const sourceFormat = metadata.format
    const format = sourceFormat === 'heif' ? 'avif' : sourceFormat
    if (!format || !(format in formatMimeTypes) || !metadata.width || !metadata.height) {
      throw new ImageInspectionError('invalid_image')
    }
    if (formatMimeTypes[sourceFormat as keyof typeof formatMimeTypes] !== declaredMimeType) {
      throw new ImageInspectionError('image_type_mismatch')
    }
    const frames = metadata.pages ?? 1
    const frameHeight = metadata.pageHeight ?? metadata.height
    const totalPixels = BigInt(metadata.width) * BigInt(frameHeight) * BigInt(frames)
    if (frames > limits.maxFrames || totalPixels > BigInt(limits.maxInputPixels)) {
      throw new ImageInspectionError('image_limit_exceeded')
    }
    return {
      format: format as ImageInspection['format'],
      width: metadata.width,
      height: frameHeight,
      frames,
      orientation: metadata.orientation ?? null,
      hasAlpha: metadata.hasAlpha ?? false,
      colourSpace: metadata.space ?? 'unknown',
      channels: metadata.channels ?? 0,
      depth: metadata.depth ?? 'unknown',
      density: metadata.density ?? null,
      processor: {
        name: 'sharp',
        version: sharp.versions.sharp,
        engine: 'libvips',
        engineVersion: sharp.versions.vips,
      },
    }
  } catch (error) {
    if (error instanceof ImageInspectionError) throw error
    if (signal?.aborted) throw signal.reason
    const message = error instanceof Error ? error.message : ''
    if (/pixel|limit|memory|width|height|page/i.test(message)) {
      throw new ImageInspectionError('image_limit_exceeded')
    }
    throw new ImageInspectionError('invalid_image')
  } finally {
    signal?.removeEventListener('abort', abort)
    source.unpipe(decoder)
    source.destroy()
    decoder.destroy()
  }
}
