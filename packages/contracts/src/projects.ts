const projectProperties = {
  id: { type: 'string', format: 'uuid' },
  organizationId: { type: 'string', format: 'uuid' },
  name: { type: 'string', minLength: 1, maxLength: 100 },
  slug: {
    type: 'string',
    minLength: 2,
    maxLength: 63,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  },
  version: { type: 'integer', minimum: 1 },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const

export const projectSchema = {
  $id: 'Project',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'organizationId', 'name', 'slug', 'version', 'createdAt', 'updatedAt'],
  properties: projectProperties,
} as const

export interface Project {
  id: string
  organizationId: string
  name: string
  slug: string
  version: number
  createdAt: string
  updatedAt: string
}

export const projectListSchema = {
  $id: 'ProjectList',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', maxItems: 100, items: projectSchema },
  },
} as const

export interface ProjectList {
  items: Project[]
}

export const createProjectRequestSchema = {
  $id: 'CreateProjectRequest',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slug'],
  properties: { name: projectProperties.name, slug: projectProperties.slug },
} as const

export interface CreateProjectRequest {
  name: string
  slug: string
}

export const updateProjectRequestSchema = {
  $id: 'UpdateProjectRequest',
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: { name: projectProperties.name, slug: projectProperties.slug },
} as const

export interface UpdateProjectRequest {
  name?: string
  slug?: string
}
