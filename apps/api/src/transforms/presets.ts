import {
  type CreateTransformPresetRequest,
  type CreateTransformPresetVersionRequest,
  createTransformPresetSelector,
  isTransformPresetName,
  parseImageTransformV1,
  type TransformPreset,
  type TransformPresetList,
  TransformSpecError,
  transformGrammarVersion,
} from '@aeonic/contracts'
import { and, desc, eq, lt } from 'drizzle-orm'
import { validate as isUuid, v7 as uuidv7 } from 'uuid'
import type { DatabaseConnection } from '../db/database.js'
import { auditEvents, transformPresets } from '../db/schema.js'
import { ApiError } from '../http/api-error.js'
import type { ProjectService } from '../projects/service.js'

type TransformPresetRow = typeof transformPresets.$inferSelect

function toPreset(row: TransformPresetRow): TransformPreset {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    selector: createTransformPresetSelector(row.name, row.version),
    canonicalSpec: row.canonicalSpec,
    definition: row.definition,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

function invalidName(): ApiError {
  return new ApiError(
    400,
    'Invalid preset name',
    'invalid_transform_preset_name',
    'Preset names must be lowercase slugs of at most 64 characters.',
  )
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'Transform preset not found',
    'transform_preset_not_found',
    'The requested transform preset version does not exist.',
  )
}

function conflict(): ApiError {
  return new ApiError(
    409,
    'Transform preset already exists',
    'transform_preset_conflict',
    'The preset name already has an initial version.',
  )
}

function parseDefinition(specification: string) {
  try {
    return parseImageTransformV1(specification)
  } catch (error) {
    if (error instanceof TransformSpecError) {
      throw new ApiError(400, 'Invalid transform', error.code, error.message)
    }
    throw error
  }
}

function parseVersion(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    throw new ApiError(
      400,
      'Invalid preset version',
      'invalid_transform_preset_version',
      'Preset versions must be positive integers.',
    )
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version)) {
    throw new ApiError(
      400,
      'Invalid preset version',
      'invalid_transform_preset_version',
      'Preset versions must be positive safe integers.',
    )
  }
  return version
}

function isUniqueFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

export class TransformPresetService {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly projects: ProjectService,
  ) {}

  list(
    userId: string,
    organizationId: string,
    projectId: string,
    options: { cursor?: string; limit: number },
  ): TransformPresetList {
    this.projects.get(userId, organizationId, projectId)
    if (options.cursor && !isUuid(options.cursor)) {
      throw new ApiError(400, 'Invalid cursor', 'invalid_cursor', 'The cursor is not valid.')
    }
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new ApiError(400, 'Invalid limit', 'invalid_limit', 'Limit must be between 1 and 100.')
    }
    const rows = this.database.db
      .select()
      .from(transformPresets)
      .where(
        and(
          eq(transformPresets.organizationId, organizationId),
          eq(transformPresets.projectId, projectId),
          ...(options.cursor ? [lt(transformPresets.id, options.cursor)] : []),
        ),
      )
      .orderBy(desc(transformPresets.id))
      .limit(options.limit + 1)
      .all()
    const hasMore = rows.length > options.limit
    const page = hasMore ? rows.slice(0, options.limit) : rows
    return {
      items: page.map(toPreset),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    }
  }

  get(
    userId: string,
    organizationId: string,
    projectId: string,
    name: string,
    versionValue: string,
  ): TransformPreset {
    this.projects.get(userId, organizationId, projectId)
    if (!isTransformPresetName(name)) throw invalidName()
    const version = parseVersion(versionValue)
    const row = this.database.db
      .select()
      .from(transformPresets)
      .where(
        and(
          eq(transformPresets.organizationId, organizationId),
          eq(transformPresets.projectId, projectId),
          eq(transformPresets.name, name),
          eq(transformPresets.version, version),
        ),
      )
      .get()
    if (!row) throw notFound()
    return toPreset(row)
  }

  create(
    userId: string,
    organizationId: string,
    projectId: string,
    input: CreateTransformPresetRequest,
    requestId: string,
  ): TransformPreset {
    this.projects.get(userId, organizationId, projectId)
    this.projects.authorize(userId, organizationId, projectId, 'manage_transforms')
    if (!isTransformPresetName(input.name)) throw invalidName()
    const parsed = parseDefinition(input.transform)
    const now = new Date()
    const row: TransformPresetRow = {
      id: uuidv7(),
      organizationId,
      projectId,
      name: input.name,
      version: 1,
      grammarVersion: transformGrammarVersion,
      canonicalSpec: parsed.canonicalSpec,
      definition: parsed.plan,
      createdBy: userId,
      createdAt: now,
    }

    try {
      this.database.client
        .transaction(() => this.insertVersion(row, requestId, 'transform_preset.created'))
        .immediate()
    } catch (error) {
      if (isUniqueFailure(error)) throw conflict()
      throw error
    }
    return toPreset(row)
  }

  createVersion(
    userId: string,
    organizationId: string,
    projectId: string,
    name: string,
    input: CreateTransformPresetVersionRequest,
    requestId: string,
  ): TransformPreset {
    this.projects.get(userId, organizationId, projectId)
    this.projects.authorize(userId, organizationId, projectId, 'manage_transforms')
    if (!isTransformPresetName(name)) throw invalidName()
    const parsed = parseDefinition(input.transform)
    let created: TransformPresetRow | undefined

    try {
      this.database.client
        .transaction(() => {
          const latest = this.database.db
            .select({
              version: transformPresets.version,
              canonicalSpec: transformPresets.canonicalSpec,
            })
            .from(transformPresets)
            .where(
              and(
                eq(transformPresets.organizationId, organizationId),
                eq(transformPresets.projectId, projectId),
                eq(transformPresets.name, name),
              ),
            )
            .orderBy(desc(transformPresets.version))
            .get()
          if (!latest) throw notFound()
          if (latest.canonicalSpec === parsed.canonicalSpec) {
            throw new ApiError(
              409,
              'Transform preset is unchanged',
              'transform_preset_unchanged',
              'The latest preset version already has this canonical transformation.',
            )
          }
          if (!Number.isSafeInteger(latest.version + 1)) {
            throw new ApiError(
              409,
              'Preset version exhausted',
              'transform_preset_version_exhausted',
              'This preset cannot accept another version.',
            )
          }
          const now = new Date()
          created = {
            id: uuidv7(),
            organizationId,
            projectId,
            name,
            version: latest.version + 1,
            grammarVersion: transformGrammarVersion,
            canonicalSpec: parsed.canonicalSpec,
            definition: parsed.plan,
            createdBy: userId,
            createdAt: now,
          }
          this.insertVersion(created, requestId, 'transform_preset.version_created')
        })
        .immediate()
    } catch (error) {
      if (isUniqueFailure(error)) {
        throw new ApiError(
          409,
          'Preset version conflict',
          'transform_preset_version_conflict',
          'Another request created the next preset version. Retry with the new latest version.',
        )
      }
      throw error
    }
    if (!created) throw new Error('Preset version transaction completed without a result')
    return toPreset(created)
  }

  private insertVersion(
    row: TransformPresetRow,
    requestId: string,
    action: 'transform_preset.created' | 'transform_preset.version_created',
  ): void {
    this.database.db.insert(transformPresets).values(row).run()
    this.database.db
      .insert(auditEvents)
      .values({
        id: uuidv7(),
        organizationId: row.organizationId,
        projectId: row.projectId,
        actorType: 'user',
        actorId: row.createdBy,
        action,
        targetType: 'transform_preset',
        targetId: row.id,
        requestId,
        summary: {
          name: row.name,
          version: row.version,
          selector: createTransformPresetSelector(row.name, row.version),
          canonicalSpec: row.canonicalSpec,
        },
        createdAt: row.createdAt,
      })
      .run()
  }
}
