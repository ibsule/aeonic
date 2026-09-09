export const projectMemberSchema = {
  $id: 'ProjectMember',
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'name', 'email', 'role', 'assignedAt'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'] },
    assignedAt: { type: 'string', format: 'date-time' },
  },
} as const

export interface ProjectMember {
  userId: string
  name: string
  email: string
  role: 'owner' | 'admin' | 'developer' | 'viewer'
  assignedAt: string
}

export const projectMemberListSchema = {
  $id: 'ProjectMemberList',
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: { type: 'array', maxItems: 100, items: projectMemberSchema },
  },
} as const

export interface ProjectMemberList {
  items: ProjectMember[]
}

export const assignProjectMemberRequestSchema = {
  $id: 'AssignProjectMemberRequest',
  type: 'object',
  additionalProperties: false,
  required: ['userId'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
  },
} as const

export interface AssignProjectMemberRequest {
  userId: string
}
