import { ApiError } from '../http/api-error.js'

export const tusVersion = '1.0.0'
export const tusExtensions = 'creation,expiration,checksum,termination'
export const tusChecksumAlgorithms = 'sha1,sha256'

export interface TusMetadata {
  readonly raw: string
  readonly values: ReadonlyMap<string, string>
}

export interface TusChecksum {
  readonly algorithm: 'sha1' | 'sha256'
  readonly digest: Buffer
}

function invalid(code: string, detail: string, status = 400): ApiError {
  return new ApiError(status, 'Invalid resumable upload', code, detail)
}

export function requireTusVersion(value: string | undefined): void {
  if (value !== tusVersion) {
    throw invalid(
      'unsupported_tus_version',
      'Tus-Resumable must select the supported tus protocol version.',
      412,
    )
  }
}

export function parseTusInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) {
    throw invalid('invalid_tus_header', `${name} must be a non-negative integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw invalid('invalid_tus_header', `${name} exceeds the supported integer range.`)
  }
  return parsed
}

function decodeMetadataValue(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw invalid('invalid_upload_metadata', 'Upload-Metadata contains invalid Base64.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) {
    throw invalid('invalid_upload_metadata', 'Upload-Metadata must use canonical Base64.')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid('invalid_upload_metadata', 'Upload-Metadata text must be valid UTF-8.')
  }
}

export function parseTusMetadata(value: string | undefined): TusMetadata {
  if (value === undefined || value.length === 0 || value.length > 4_096) {
    throw invalid(
      'invalid_upload_metadata',
      'Upload-Metadata is required and must not exceed 4096 characters.',
    )
  }
  if (value.includes('\r') || value.includes('\n')) {
    throw invalid('invalid_upload_metadata', 'Upload-Metadata cannot contain line breaks.')
  }

  const values = new Map<string, string>()
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim()
    const separator = entry.indexOf(' ')
    const key = separator < 0 ? entry : entry.slice(0, separator)
    const encoded = separator < 0 ? '' : entry.slice(separator + 1)
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || values.has(key)) {
      throw invalid(
        'invalid_upload_metadata',
        'Upload-Metadata keys must be unique, safe ASCII identifiers.',
      )
    }
    values.set(key, encoded === '' ? '' : decodeMetadataValue(encoded))
  }

  if (!values.get('filename') || !values.get('filetype')) {
    throw invalid(
      'missing_upload_metadata',
      'Upload-Metadata must include Base64-encoded filename and filetype values.',
    )
  }
  return { raw: value, values }
}

export function parseTusChecksum(value: string | undefined): TusChecksum | undefined {
  if (value === undefined) return undefined
  const match = /^(sha1|sha256) ([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match?.[1] || !match[2]) {
    throw invalid(
      'unsupported_checksum',
      'Upload-Checksum must contain a supported algorithm and Base64 digest.',
    )
  }
  const algorithm = match[1] as TusChecksum['algorithm']
  const digest = Buffer.from(match[2], 'base64')
  const expectedBytes = algorithm === 'sha1' ? 20 : 32
  if (digest.byteLength !== expectedBytes || digest.toString('base64') !== match[2]) {
    throw invalid('invalid_upload_checksum', 'Upload-Checksum contains an invalid digest.')
  }
  return { algorithm, digest }
}
