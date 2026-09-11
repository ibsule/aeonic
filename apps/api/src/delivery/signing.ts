import { createHmac, timingSafeEqual } from 'node:crypto'
import type { DeliveryDisposition } from '@aeonic/contracts'
import type { DeliverySigningKey } from '../config.js'

export interface DeliverySignature {
  expires: number
  keyId: string
  signature: string
}

export interface DeliverySignatureInput extends DeliverySignature {
  disposition: DeliveryDisposition
  path: string
}

function signaturePayload(
  keyId: string,
  path: string,
  expires: number,
  disposition: DeliveryDisposition,
): string {
  return `aeonic-delivery-v1\n${keyId}\n${path}\n${expires}\n${disposition}`
}

function sign(
  secret: string,
  keyId: string,
  path: string,
  expires: number,
  disposition: DeliveryDisposition,
): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(signaturePayload(keyId, path, expires, disposition))
    .digest()
}

export class DeliverySigner {
  readonly #keys: ReadonlyMap<string, DeliverySigningKey>
  readonly #activeKey: DeliverySigningKey

  constructor(keys: readonly DeliverySigningKey[]) {
    if (keys.length === 0) throw new Error('Delivery signing requires at least one key')
    this.#keys = new Map(keys.map((key) => [key.id, key]))
    this.#activeKey = keys[0] as DeliverySigningKey
  }

  create(path: string, expires: number, disposition: DeliveryDisposition): DeliverySignature {
    return {
      expires,
      keyId: this.#activeKey.id,
      signature: sign(
        this.#activeKey.secret,
        this.#activeKey.id,
        path,
        expires,
        disposition,
      ).toString('base64url'),
    }
  }

  verify(input: DeliverySignatureInput, now = new Date()): boolean {
    if (!Number.isSafeInteger(input.expires) || input.expires <= Math.floor(now.getTime() / 1000)) {
      return false
    }
    const key = this.#keys.get(input.keyId)
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(input.signature)) return false
    const supplied = Buffer.from(input.signature, 'base64url')
    if (supplied.byteLength !== 32) return false
    const expected = sign(key.secret, input.keyId, input.path, input.expires, input.disposition)
    return timingSafeEqual(supplied, expected)
  }
}

export function createOriginalDeliveryPath(input: {
  projectId: string
  publicId: string
  version: number
  filename: string
}): string {
  return `/m/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.publicId)}/v${input.version}/original/${encodeURIComponent(input.filename)}`
}
