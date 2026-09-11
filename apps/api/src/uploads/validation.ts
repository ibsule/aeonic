import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { MediaKind, UploadQuery } from '@aeonic/contracts'
import { fileTypeFromStream } from 'file-type'
import { ApiError } from '../http/api-error.js'
import type { TenantScope } from '../repositories/types.js'
import type { StorageObjectKey, StoragePort } from '../storage/contracts.js'

interface SupportedType {
  readonly extensions: readonly string[]
  readonly kind: MediaKind
}

const supportedTypes: Readonly<Record<string, SupportedType>> = {
  'image/jpeg': { extensions: ['jpg', 'jpeg'], kind: 'image' },
  'image/png': { extensions: ['png'], kind: 'image' },
  'image/gif': { extensions: ['gif'], kind: 'image' },
  'image/webp': { extensions: ['webp'], kind: 'image' },
  'image/avif': { extensions: ['avif'], kind: 'image' },
  'video/mp4': { extensions: ['mp4', 'm4v'], kind: 'video' },
  'video/webm': { extensions: ['webm'], kind: 'video' },
  'video/quicktime': { extensions: ['mov'], kind: 'video' },
  'application/pdf': { extensions: ['pdf'], kind: 'document' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    extensions: ['docx'],
    kind: 'document',
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    extensions: ['pptx'],
    kind: 'document',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extensions: ['xlsx'],
    kind: 'document',
  },
}

const declaredMimeAliases: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'video/x-m4v': 'video/mp4',
}

export interface UploadDescriptor {
  filename: string
  name: string
  folder: string
  visibility: 'private' | 'public'
  extension: string
  declaredMimeType: string
  mediaKind: MediaKind
}

function invalid(code: string, detail: string, status = 400): ApiError {
  return new ApiError(status, 'Invalid upload', code, detail)
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })
}

function normalizeFolder(folder: string | undefined): string {
  if (!folder) return ''
  const value = folder.trim().replaceAll('\\', '/')
  if (
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacter(value)
  ) {
    throw invalid(
      'invalid_folder',
      'Folder must be a relative logical path without empty segments.',
    )
  }
  return value
}

function normalizeMimeType(contentType: string | undefined): string {
  if (!contentType) {
    throw invalid('content_type_required', 'Provide the file media type in Content-Type.', 415)
  }
  const raw = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return declaredMimeAliases[raw] ?? raw
}

export function validateUploadDescriptor(
  query: UploadQuery,
  contentType: string | undefined,
): UploadDescriptor {
  const filename = query.filename.normalize('NFC').trim()
  if (
    filename === '' ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    hasControlCharacter(filename)
  ) {
    throw invalid('invalid_filename', 'Filename must be a plain filename without path segments.')
  }

  const extension = extname(filename).slice(1).toLowerCase()
  const declaredMimeType = normalizeMimeType(contentType)
  const supported = supportedTypes[declaredMimeType]
  if (!supported?.extensions.includes(extension)) {
    throw invalid(
      'unsupported_media_type',
      'The declared media type and filename extension are not an allowed combination.',
      415,
    )
  }

  const fallbackName = filename.slice(0, Math.max(1, filename.length - extension.length - 1))
  const name = (query.name ?? fallbackName).normalize('NFC').trim()
  if (name === '' || name.length > 100 || hasControlCharacter(name)) {
    throw invalid('invalid_asset_name', 'Asset name must contain 1 to 100 printable characters.')
  }

  return {
    filename,
    name,
    folder: normalizeFolder(query.folder),
    visibility: query.visibility ?? 'private',
    extension,
    declaredMimeType,
    mediaKind: supported.kind,
  }
}

export function parseContentDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(value.trim())
  if (!match?.[1]) {
    throw invalid(
      'invalid_content_digest',
      'Content-Digest must contain one SHA-256 value using RFC 9530 binary syntax.',
    )
  }
  const digest = Buffer.from(match[1], 'base64')
  if (digest.byteLength !== 32 || digest.toString('base64') !== match[1]) {
    throw invalid('invalid_content_digest', 'Content-Digest contains an invalid SHA-256 value.')
  }
  return digest.toString('hex')
}

export class UploadContentError extends Error {
  override readonly name = 'UploadContentError'

  constructor(readonly code: 'media_type_mismatch' | 'unrecognized_content') {
    super(
      code === 'media_type_mismatch'
        ? 'The file content does not match its declared media type and extension.'
        : 'The file content is not a recognized supported media format.',
    )
  }
}

export async function validateStoredContent(
  storage: StoragePort,
  scope: TenantScope,
  key: StorageObjectKey,
  descriptor: UploadDescriptor,
): Promise<void> {
  const source = await storage.open(scope, key)
  try {
    const detected = await fileTypeFromStream(Readable.toWeb(source))
    if (!detected) throw new UploadContentError('unrecognized_content')
    const detectedMime = declaredMimeAliases[detected.mime] ?? detected.mime
    const supported = supportedTypes[detectedMime]
    if (
      detectedMime !== descriptor.declaredMimeType ||
      !supported ||
      !supported.extensions.includes(descriptor.extension)
    ) {
      throw new UploadContentError('media_type_mismatch')
    }
  } finally {
    source.destroy()
  }
}
