export const deliveryDispositions = ['inline', 'attachment'] as const
export type DeliveryDisposition = (typeof deliveryDispositions)[number]

export const createDeliveryUrlRequestSchema = {
  $id: 'CreateDeliveryUrlRequest',
  type: 'object',
  additionalProperties: false,
  properties: {
    expiresInSeconds: { type: 'integer', minimum: 60, maximum: 86_400 },
    disposition: { type: 'string', enum: deliveryDispositions },
  },
} as const

export interface CreateDeliveryUrlRequest {
  expiresInSeconds?: number
  disposition?: DeliveryDisposition
}

export const deliveryUrlSchema = {
  $id: 'DeliveryUrl',
  type: 'object',
  additionalProperties: false,
  required: ['url', 'expiresAt'],
  properties: {
    url: { type: 'string', format: 'uri' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface DeliveryUrl {
  url: string
  expiresAt: string
}
