export const transformGrammarVersion = 1 as const

export const transformFits = ['cover', 'contain', 'fill', 'inside', 'outside'] as const
export type TransformFit = (typeof transformFits)[number]

export const transformGravities = [
  'center',
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
  'entropy',
  'attention',
] as const
export type TransformGravity = (typeof transformGravities)[number]

export const transformFormats = ['source', 'auto', 'jpeg', 'png', 'webp', 'avif'] as const
export type TransformFormat = (typeof transformFormats)[number]

export interface ImageTransformPlanV1 {
  readonly grammarVersion: typeof transformGrammarVersion
  readonly autoOrient: true
  readonly fit: TransformFit
  readonly gravity: TransformGravity
  readonly format: TransformFormat
  readonly quality: number
  readonly width?: number
  readonly height?: number
  readonly blur?: number
  readonly sharpen?: number
}

export interface CanonicalImageTransformV1 {
  readonly canonicalSpec: string
  readonly plan: ImageTransformPlanV1
}

export const transformPresetNamePattern = '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$'
const transformPresetNameExpression = new RegExp(transformPresetNamePattern)

export function isTransformPresetName(value: string): boolean {
  return transformPresetNameExpression.test(value)
}

export function createTransformPresetSelector(name: string, version: number): string {
  if (!isTransformPresetName(name) || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('A preset selector requires a valid name and positive integer version.')
  }
  return `p_${name}.v${version}`
}

export interface TransformPresetSelector {
  readonly name: string
  readonly version: number
}

export function parseTransformPresetSelector(value: string): TransformPresetSelector | null {
  const matched = /^p_([a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63})\.v([1-9]\d{0,15})$/.exec(value)
  if (!matched) return null
  const version = Number(matched[2])
  if (!Number.isSafeInteger(version)) return null
  return Object.freeze({ name: matched[1] as string, version })
}

export const imageTransformPlanV1Schema = {
  $id: 'ImageTransformPlanV1',
  type: 'object',
  additionalProperties: false,
  required: ['grammarVersion', 'autoOrient', 'fit', 'gravity', 'format', 'quality'],
  properties: {
    grammarVersion: { type: 'integer', const: transformGrammarVersion },
    autoOrient: { type: 'boolean', const: true },
    fit: { type: 'string', enum: transformFits },
    gravity: { type: 'string', enum: transformGravities },
    format: { type: 'string', enum: transformFormats },
    quality: { type: 'integer', minimum: 1, maximum: 100 },
    width: { type: 'integer', minimum: 1, maximum: 8_192 },
    height: { type: 'integer', minimum: 1, maximum: 8_192 },
    blur: { type: 'number', minimum: 0.3, maximum: 100 },
    sharpen: { type: 'number', minimum: 0.3, maximum: 10 },
  },
} as const

export const createTransformPresetRequestSchema = {
  $id: 'CreateTransformPresetRequest',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'transform'],
  properties: {
    name: { type: 'string', pattern: transformPresetNamePattern, maxLength: 64 },
    transform: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

export interface CreateTransformPresetRequest {
  name: string
  transform: string
}

export const createTransformPresetVersionRequestSchema = {
  $id: 'CreateTransformPresetVersionRequest',
  type: 'object',
  additionalProperties: false,
  required: ['transform'],
  properties: {
    transform: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

export interface CreateTransformPresetVersionRequest {
  transform: string
}

export const transformPresetSchema = {
  $id: 'TransformPreset',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'organizationId',
    'projectId',
    'name',
    'version',
    'selector',
    'canonicalSpec',
    'definition',
    'createdBy',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    organizationId: { type: 'string', format: 'uuid' },
    projectId: { type: 'string', format: 'uuid' },
    name: { type: 'string', pattern: transformPresetNamePattern, maxLength: 64 },
    version: { type: 'integer', minimum: 1 },
    selector: {
      type: 'string',
      pattern: '^p_[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}\\.v[1-9][0-9]*$',
    },
    canonicalSpec: { type: 'string', minLength: 1, maxLength: 256 },
    definition: imageTransformPlanV1Schema,
    createdBy: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface TransformPreset {
  id: string
  organizationId: string
  projectId: string
  name: string
  version: number
  selector: string
  canonicalSpec: string
  definition: ImageTransformPlanV1
  createdBy: string
  createdAt: string
}

export const transformPresetListSchema = {
  $id: 'TransformPresetList',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', maxItems: 100, items: transformPresetSchema },
    nextCursor: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
  },
} as const

export interface TransformPresetList {
  items: TransformPreset[]
  nextCursor: string | null
}

export type TransformSpecErrorCode =
  | 'empty_transform'
  | 'transform_too_long'
  | 'too_many_operations'
  | 'malformed_operation'
  | 'unknown_operation'
  | 'duplicate_operation'
  | 'invalid_operation_value'
  | 'conflicting_operations'
  | 'output_too_large'

export class TransformSpecError extends Error {
  override readonly name = 'TransformSpecError'

  constructor(
    readonly code: TransformSpecErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const MAX_SPEC_LENGTH = 256
const MAX_OPERATIONS = 12
const MAX_DIMENSION = 8_192
const MAX_OUTPUT_PIXELS = 40_000_000
const DEFAULT_QUALITY = 80
const operationOrder = ['w', 'h', 'fit', 'g', 'f', 'q', 'blur', 'sharpen'] as const
type OperationName = (typeof operationOrder)[number]

function isOperationName(value: string): value is OperationName {
  return operationOrder.includes(value as OperationName)
}

function parseInteger(value: string, minimum: number, maximum: number, operation: string): number {
  if (!/^\d{1,10}$/.test(value)) {
    throw new TransformSpecError(
      'invalid_operation_value',
      `${operation} must be a base-10 integer.`,
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TransformSpecError(
      'invalid_operation_value',
      `${operation} must be between ${minimum} and ${maximum}.`,
    )
  }
  return parsed
}

function parseDecimal(value: string, minimum: number, maximum: number, operation: string): number {
  if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(value)) {
    throw new TransformSpecError(
      'invalid_operation_value',
      `${operation} must be a plain decimal with at most three fractional digits.`,
    )
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TransformSpecError(
      'invalid_operation_value',
      `${operation} must be between ${minimum} and ${maximum}.`,
    )
  }
  return parsed
}

function parseEnum<T extends string>(value: string, allowed: readonly T[], operation: string): T {
  if (!allowed.includes(value as T)) {
    throw new TransformSpecError(
      'invalid_operation_value',
      `${operation} must be one of: ${allowed.join(', ')}.`,
    )
  }
  return value as T
}

function readOperations(specification: string): ReadonlyMap<OperationName, string> {
  if (specification.length === 0) {
    throw new TransformSpecError('empty_transform', 'A transform specification is required.')
  }
  if (specification.length > MAX_SPEC_LENGTH) {
    throw new TransformSpecError(
      'transform_too_long',
      `A transform specification cannot exceed ${MAX_SPEC_LENGTH} characters.`,
    )
  }
  if (!/^[a-z0-9_.,]+$/.test(specification)) {
    throw new TransformSpecError(
      'malformed_operation',
      'Transform specifications may contain only lowercase ASCII operations.',
    )
  }

  const tokens = specification.split(',')
  if (tokens.length > MAX_OPERATIONS) {
    throw new TransformSpecError(
      'too_many_operations',
      `A transform specification cannot contain more than ${MAX_OPERATIONS} operations.`,
    )
  }

  const operations = new Map<OperationName, string>()
  for (const token of tokens) {
    const separator = token.indexOf('_')
    if (separator < 1 || separator === token.length - 1 || token.indexOf('_', separator + 1) >= 0) {
      throw new TransformSpecError('malformed_operation', `Malformed transform operation: ${token}`)
    }
    const name = token.slice(0, separator)
    if (!isOperationName(name)) {
      throw new TransformSpecError('unknown_operation', `Unknown transform operation: ${name}`)
    }
    if (operations.has(name)) {
      throw new TransformSpecError('duplicate_operation', `Duplicate transform operation: ${name}`)
    }
    operations.set(name, token.slice(separator + 1))
  }
  return operations
}

export function parseImageTransformV1(specification: string): CanonicalImageTransformV1 {
  const operations = readOperations(specification)
  const width = operations.has('w')
    ? parseInteger(operations.get('w') as string, 1, MAX_DIMENSION, 'w')
    : undefined
  const height = operations.has('h')
    ? parseInteger(operations.get('h') as string, 1, MAX_DIMENSION, 'h')
    : undefined
  const fit = operations.has('fit')
    ? parseEnum(operations.get('fit') as string, transformFits, 'fit')
    : 'cover'
  const gravity = operations.has('g')
    ? parseEnum(operations.get('g') as string, transformGravities, 'g')
    : 'center'
  const format = operations.has('f')
    ? parseEnum(operations.get('f') as string, transformFormats.slice(1), 'f')
    : 'source'
  const quality = operations.has('q')
    ? parseInteger(operations.get('q') as string, 1, 100, 'q')
    : DEFAULT_QUALITY
  const blur = operations.has('blur')
    ? parseDecimal(operations.get('blur') as string, 0.3, 100, 'blur')
    : undefined
  const sharpen = operations.has('sharpen')
    ? parseDecimal(operations.get('sharpen') as string, 0.3, 10, 'sharpen')
    : undefined

  if (
    (operations.has('fit') || operations.has('g')) &&
    (width === undefined || height === undefined)
  ) {
    throw new TransformSpecError(
      'conflicting_operations',
      'fit and gravity require both width and height.',
    )
  }
  if (operations.has('g') && fit !== 'cover') {
    throw new TransformSpecError(
      'conflicting_operations',
      'gravity is supported only with the cover fit.',
    )
  }
  if (operations.has('q') && format === 'source') {
    throw new TransformSpecError(
      'conflicting_operations',
      'quality requires an explicit output format.',
    )
  }
  if (width !== undefined && height !== undefined && width * height > MAX_OUTPUT_PIXELS) {
    throw new TransformSpecError(
      'output_too_large',
      `Requested dimensions exceed the ${MAX_OUTPUT_PIXELS}-pixel output limit.`,
    )
  }

  const canonicalOperations: string[] = []
  if (width !== undefined) canonicalOperations.push(`w_${width}`)
  if (height !== undefined) canonicalOperations.push(`h_${height}`)
  if (width !== undefined && height !== undefined && fit !== 'cover') {
    canonicalOperations.push(`fit_${fit}`)
  }
  if (width !== undefined && height !== undefined && gravity !== 'center') {
    canonicalOperations.push(`g_${gravity}`)
  }
  if (format !== 'source') canonicalOperations.push(`f_${format}`)
  if (format !== 'source' && quality !== DEFAULT_QUALITY) canonicalOperations.push(`q_${quality}`)
  if (blur !== undefined) canonicalOperations.push(`blur_${blur}`)
  if (sharpen !== undefined) canonicalOperations.push(`sharpen_${sharpen}`)

  const plan: ImageTransformPlanV1 = Object.freeze({
    grammarVersion: transformGrammarVersion,
    autoOrient: true,
    fit,
    gravity,
    format,
    quality,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(blur === undefined ? {} : { blur }),
    ...(sharpen === undefined ? {} : { sharpen }),
  })
  return Object.freeze({ canonicalSpec: canonicalOperations.join(','), plan })
}
