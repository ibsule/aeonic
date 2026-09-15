import { createHash } from 'node:crypto'
import { parseImageTransformV1, transformGrammarVersion } from '@aeonic/contracts'
import type { ImageOutputFormat } from '../media/image-transformer.js'

export interface DerivativeCacheIdentity {
  readonly sourceSha256: string
  readonly canonicalSpec: string
  readonly outputFormat: ImageOutputFormat
  readonly processorFingerprint: string
}

export function createDerivativeCacheKey(identity: DerivativeCacheIdentity): string {
  if (!/^[0-9a-f]{64}$/.test(identity.sourceSha256)) {
    throw new TypeError('A derivative cache identity requires a lowercase SHA-256 source digest.')
  }
  const parsed = parseImageTransformV1(identity.canonicalSpec)
  if (parsed.canonicalSpec !== identity.canonicalSpec) {
    throw new TypeError('A derivative cache identity requires a canonical transform specification.')
  }
  if (
    parsed.plan.format !== 'source' &&
    parsed.plan.format !== 'auto' &&
    parsed.plan.format !== identity.outputFormat
  ) {
    throw new TypeError('The derivative output format conflicts with the transform specification.')
  }
  if (
    identity.processorFingerprint.length < 1 ||
    identity.processorFingerprint.length > 256 ||
    !/^[A-Za-z0-9._=;:@/+-]+$/.test(identity.processorFingerprint)
  ) {
    throw new TypeError('A derivative cache identity requires a safe processor fingerprint.')
  }

  return createHash('sha256')
    .update(
      [
        'aeonic-derivative-cache-v1',
        identity.sourceSha256,
        String(transformGrammarVersion),
        identity.canonicalSpec,
        identity.outputFormat,
        identity.processorFingerprint,
      ].join('\n'),
    )
    .digest('hex')
}
