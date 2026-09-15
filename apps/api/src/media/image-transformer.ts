import type { Readable } from 'node:stream'
import type { ImageTransformPlanV1, TransformFormat } from '@aeonic/contracts'
import sharp from 'sharp'

export type ImageOutputFormat = Exclude<TransformFormat, 'source' | 'auto'>

export interface ImageTransformLimits {
  readonly maxInputPixels: number
  readonly maxFrames: number
}

export interface ImageTransformOutput {
  readonly stream: Readable
  readonly format: ImageOutputFormat
  readonly mimeType: `image/${ImageOutputFormat}`
  readonly extension: 'jpg' | 'png' | 'webp' | 'avif'
  readonly processor: {
    readonly name: 'sharp'
    readonly version: string
    readonly engine: 'libvips'
    readonly engineVersion: string
  }
}

export class ImageTransformError extends Error {
  override readonly name = 'ImageTransformError'

  constructor(readonly code: 'invalid_image' | 'image_limit_exceeded' | 'output_format_mismatch') {
    super(
      code === 'invalid_image'
        ? 'The image decoder rejected the transform input.'
        : code === 'image_limit_exceeded'
          ? 'The image exceeds the configured transform limits.'
          : 'The resolved output format conflicts with the canonical transform plan.',
    )
  }
}

const outputDetails = {
  jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
  png: { mimeType: 'image/png', extension: 'png' },
  webp: { mimeType: 'image/webp', extension: 'webp' },
  avif: { mimeType: 'image/avif', extension: 'avif' },
} as const

function validateLimits(limits: ImageTransformLimits): void {
  if (!Number.isSafeInteger(limits.maxInputPixels) || limits.maxInputPixels < 1) {
    throw new TypeError('maxInputPixels must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(limits.maxFrames) || limits.maxFrames < 1) {
    throw new TypeError('maxFrames must be a positive safe integer.')
  }
}

function configureOutput(
  processor: ReturnType<typeof sharp>,
  format: ImageOutputFormat,
  quality: number,
): void {
  if (format === 'jpeg') {
    processor.jpeg({ quality, progressive: true, chromaSubsampling: '4:4:4' })
  } else if (format === 'png') {
    processor.png({ compressionLevel: 9, adaptiveFiltering: false })
  } else if (format === 'webp') {
    processor.webp({ quality, effort: 4, smartSubsample: true })
  } else {
    processor.avif({ quality, effort: 4, chromaSubsampling: '4:4:4' })
  }
}

export async function transformImage(
  source: Readable,
  plan: ImageTransformPlanV1,
  outputFormat: ImageOutputFormat,
  limits: ImageTransformLimits,
  signal?: AbortSignal,
): Promise<ImageTransformOutput> {
  try {
    validateLimits(limits)
    signal?.throwIfAborted()
  } catch (error) {
    source.destroy()
    throw error
  }
  if (plan.format !== 'source' && plan.format !== 'auto' && plan.format !== outputFormat) {
    source.destroy()
    throw new ImageTransformError('output_format_mismatch')
  }

  const processor = sharp({
    animated: true,
    pages: -1,
    sequentialRead: true,
    limitInputPixels: limits.maxInputPixels,
    limitInputChannels: 4,
    failOn: 'warning',
  })
  const abort = (): void => {
    const reason = signal?.reason
    source.destroy(reason instanceof Error ? reason : undefined)
    processor.destroy(reason instanceof Error ? reason : undefined)
  }
  let sourceFailure: Error | undefined
  let rejectSourceFailure: (error: Error) => void = () => undefined
  const sourceFailed = new Promise<never>((_resolve, reject) => {
    rejectSourceFailure = reject
  })
  const sourceError = (error: Error): void => {
    sourceFailure = error
    rejectSourceFailure(error)
    processor.destroy()
  }
  source.once('error', sourceError)
  signal?.addEventListener('abort', abort, { once: true })
  processor.rotate()
  if (plan.width !== undefined || plan.height !== undefined) {
    processor.resize({
      ...(plan.width === undefined ? {} : { width: plan.width }),
      ...(plan.height === undefined ? {} : { height: plan.height }),
      fit: plan.fit,
      position: plan.gravity,
    })
  }
  if (plan.blur !== undefined) processor.blur(plan.blur)
  if (plan.sharpen !== undefined) processor.sharpen({ sigma: plan.sharpen })
  configureOutput(processor, outputFormat, plan.quality)
  source.pipe(processor)

  try {
    const metadata = await Promise.race([processor.metadata(), sourceFailed])
    if (!metadata.width || !metadata.height || !metadata.format) {
      throw new ImageTransformError('invalid_image')
    }
    const frames = metadata.pages ?? 1
    const frameHeight = metadata.pageHeight ?? metadata.height
    const totalPixels = BigInt(metadata.width) * BigInt(frameHeight) * BigInt(frames)
    if (frames > limits.maxFrames || totalPixels > BigInt(limits.maxInputPixels)) {
      throw new ImageTransformError('image_limit_exceeded')
    }

    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
      source.removeListener('error', sourceError)
    }
    processor.once('close', cleanup)
    processor.once('end', cleanup)
    processor.once('error', cleanup)
    const details = outputDetails[outputFormat]
    return {
      stream: processor,
      format: outputFormat,
      mimeType: details.mimeType,
      extension: details.extension,
      processor: {
        name: 'sharp',
        version: sharp.versions.sharp,
        engine: 'libvips',
        engineVersion: sharp.versions.vips,
      },
    }
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    source.removeListener('error', sourceError)
    source.unpipe(processor)
    source.destroy()
    processor.destroy()
    if (error instanceof ImageTransformError) throw error
    if (signal?.aborted) throw signal.reason
    if (error === sourceFailure) throw error
    const message = error instanceof Error ? error.message : ''
    if (/pixel|limit|memory|width|height|page/i.test(message)) {
      throw new ImageTransformError('image_limit_exceeded')
    }
    throw new ImageTransformError('invalid_image')
  }
}
