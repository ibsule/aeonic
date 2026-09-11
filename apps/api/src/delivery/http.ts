import type { DeliveryDisposition } from '@aeonic/contracts'

export interface ByteRange {
  start: number
  end: number
}

export class InvalidRangeError extends Error {
  override readonly name = 'InvalidRangeError'
}

function integer(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parseSingleByteRange(value: string, sizeBytes: number): ByteRange {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !value.startsWith('bytes=')) {
    throw new InvalidRangeError('The byte range is invalid.')
  }
  const specification = value.slice(6).trim()
  if (specification.includes(',')) {
    throw new InvalidRangeError('Multiple byte ranges are not supported.')
  }
  const match = /^(\d*)-(\d*)$/.exec(specification)
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new InvalidRangeError('The byte range is invalid.')
  }

  if (match[1] === '') {
    const suffixLength = integer(match[2] ?? '')
    if (suffixLength === null || suffixLength === 0) {
      throw new InvalidRangeError('The suffix byte range is invalid.')
    }
    return { start: Math.max(0, sizeBytes - suffixLength), end: sizeBytes - 1 }
  }

  const start = integer(match[1] ?? '')
  const requestedEnd = match[2] === '' ? sizeBytes - 1 : integer(match[2] ?? '')
  if (start === null || requestedEnd === null || start >= sizeBytes || requestedEnd < start) {
    throw new InvalidRangeError('The byte range is not satisfiable.')
  }
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) }
}

export function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//, '') === etag)
}

export function ifModifiedSinceMatches(value: string | undefined, modifiedAt: Date): boolean {
  if (value === undefined) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  return Math.floor(modifiedAt.getTime() / 1_000) <= Math.floor(parsed / 1_000)
}

export function ifRangeAllows(value: string | undefined, etag: string, modifiedAt: Date): boolean {
  if (value === undefined) return true
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag
  return ifModifiedSinceMatches(value, modifiedAt)
}

function encodedFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function contentDisposition(disposition: DeliveryDisposition, filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodedFilename(filename)}`
}
