import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { assertOutputSize, stageMediaInput } from './staged-input.js'
import { runMediaCommand } from './subprocess.js'

export interface VideoLimits {
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxDurationSeconds: number
  readonly maxWidth: number
  readonly maxHeight: number
  readonly timeoutMs: number
}

export interface VideoInspection {
  readonly format: string
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
  readonly videoCodec: string
  readonly audioCodec: string | null
}

export type VideoPreset = 'mp4-720p' | 'webm-720p'

const extensions: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

function commandLimits(limits: VideoLimits, signal?: AbortSignal) {
  return {
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 262_144,
    ...(signal ? { signal } : {}),
  }
}

export async function inspectVideo(
  source: Readable,
  mimeType: string,
  limits: VideoLimits,
  signal?: AbortSignal,
): Promise<VideoInspection> {
  const extension = extensions[mimeType]
  if (!extension) throw new TypeError('Unsupported video media type.')
  const staged = await stageMediaInput(source, extension, limits.maxInputBytes, signal)
  try {
    const result = await runMediaCommand(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name,width,height',
        '-of',
        'json',
        staged.path,
      ],
      commandLimits(limits, signal),
    )
    const parsed = JSON.parse(result.stdout.toString('utf8')) as {
      format?: { format_name?: string; duration?: string }
      streams?: Array<{
        codec_type?: string
        codec_name?: string
        width?: number
        height?: number
      }>
    }
    const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
    const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
    const durationSeconds = Number(parsed.format?.duration)
    if (
      !video?.codec_name ||
      !video.width ||
      !video.height ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > limits.maxDurationSeconds ||
      video.width > limits.maxWidth ||
      video.height > limits.maxHeight
    ) {
      throw new RangeError('Video metadata is missing or exceeds configured limits.')
    }
    return {
      format: parsed.format?.format_name ?? 'unknown',
      durationSeconds,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
    }
  } finally {
    await staged.cleanup()
  }
}

export async function createVideoDerivative(
  source: Readable,
  mimeType: string,
  preset: VideoPreset,
  limits: VideoLimits,
  options: { atSeconds?: number; clipSeconds?: number; signal?: AbortSignal } = {},
): Promise<{ content: Buffer; mimeType: string; extension: string }> {
  const extension = extensions[mimeType]
  if (!extension) throw new TypeError('Unsupported video media type.')
  const at = options.atSeconds ?? 0
  const clip = options.clipSeconds ?? limits.maxDurationSeconds
  if (!Number.isFinite(at) || at < 0 || !Number.isFinite(clip) || clip <= 0 || clip > 60) {
    throw new TypeError('Video clip bounds are invalid.')
  }
  const staged = await stageMediaInput(source, extension, limits.maxInputBytes, options.signal)
  const outputExtension = preset === 'mp4-720p' ? 'mp4' : 'webm'
  const outputPath = join(staged.directory, `output.${outputExtension}`)
  try {
    const codecArgs =
      preset === 'mp4-720p'
        ? [
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
          ]
        : ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '96k']
    await runMediaCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(at),
        '-i',
        staged.path,
        '-t',
        String(clip),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        "scale='min(1280,iw)':-2:flags=lanczos",
        ...codecArgs,
        '-y',
        outputPath,
      ],
      commandLimits(limits, options.signal),
    )
    await assertOutputSize(outputPath, limits.maxOutputBytes)
    return {
      content: await readFile(outputPath),
      mimeType: preset === 'mp4-720p' ? 'video/mp4' : 'video/webm',
      extension: outputExtension,
    }
  } finally {
    await staged.cleanup()
  }
}

export async function createVideoPoster(
  source: Readable,
  mimeType: string,
  limits: VideoLimits,
  options: { atSeconds?: number; width?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const extension = extensions[mimeType]
  const at = options.atSeconds ?? 0
  const width = options.width ?? 640
  if (
    !extension ||
    !Number.isFinite(at) ||
    at < 0 ||
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 1920
  ) {
    throw new TypeError('Video poster options are invalid.')
  }
  const staged = await stageMediaInput(source, extension, limits.maxInputBytes, options.signal)
  const outputPath = join(staged.directory, 'poster.jpg')
  try {
    await runMediaCommand(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(at),
        '-i',
        staged.path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2:flags=lanczos`,
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      commandLimits(limits, options.signal),
    )
    await assertOutputSize(outputPath, limits.maxOutputBytes)
    return readFile(outputPath)
  } finally {
    await staged.cleanup()
  }
}
