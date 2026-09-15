import type { TransformFormat } from '@aeonic/contracts'
import type { ImageOutputFormat } from '../media/image-transformer.js'

const mimeFormats: Readonly<Record<string, ImageOutputFormat>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

interface MediaRange {
  readonly type: string
  readonly subtype: string
  readonly quality: number
  readonly order: number
}

function parseAccept(value: string): MediaRange[] {
  return value.split(',').flatMap((entry, order) => {
    const [mediaType = '', ...parameters] = entry.trim().toLowerCase().split(';')
    const match = /^([a-z0-9!#$&^_.+-]+|\*)\/([a-z0-9!#$&^_.+-]+|\*)$/.exec(mediaType)
    if (!match || (match[1] === '*' && match[2] !== '*')) return []
    let quality = 1
    let sawQuality = false
    for (const parameter of parameters) {
      if (!/^\s*q\s*=/i.test(parameter)) continue
      const qualityMatch = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter)
      if (!qualityMatch || sawQuality) return []
      quality = Number(qualityMatch[1])
      sawQuality = true
    }
    return [{ type: match[1] as string, subtype: match[2] as string, quality, order }]
  })
}

function qualityFor(mimeType: string, ranges: readonly MediaRange[]): number {
  const [type, subtype] = mimeType.split('/') as [string, string]
  let selected: MediaRange | undefined
  let selectedSpecificity = -1
  for (const range of ranges) {
    if (range.type !== '*' && range.type !== type) continue
    if (range.subtype !== '*' && range.subtype !== subtype) continue
    const specificity = (range.type === '*' ? 0 : 1) + (range.subtype === '*' ? 0 : 1)
    if (
      specificity > selectedSpecificity ||
      (specificity === selectedSpecificity && range.order < (selected?.order ?? Number.MAX_VALUE))
    ) {
      selected = range
      selectedSpecificity = specificity
    }
  }
  return selected?.quality ?? 0
}

export function resolveImageOutputFormat(
  requested: TransformFormat,
  sourceMimeType: string,
  acceptHeader?: string,
): ImageOutputFormat | null {
  if (requested !== 'auto' && requested !== 'source') return requested
  const sourceFormat = mimeFormats[sourceMimeType]
  if (requested === 'source') return sourceFormat ?? null
  if (!acceptHeader?.trim()) return sourceFormat ?? 'webp'

  const ranges = parseAccept(acceptHeader)
  const preference = [
    'avif',
    'webp',
    ...(sourceFormat ? [sourceFormat] : []),
    'jpeg',
    'png',
  ] as const
  let selected: ImageOutputFormat | null = null
  let selectedQuality = 0
  for (const format of new Set<ImageOutputFormat>(preference)) {
    const quality = qualityFor(`image/${format}`, ranges)
    if (quality > selectedQuality) {
      selected = format
      selectedQuality = quality
    }
  }
  return selected
}
