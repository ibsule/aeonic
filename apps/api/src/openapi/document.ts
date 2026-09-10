import {
  apiKeyListSchema,
  auditEventListSchema,
  createApiKeyRequestSchema,
  createdApiKeySchema,
  createProjectRequestSchema,
  problemDetailsSchema,
  projectListSchema,
  projectMemberListSchema,
  projectMemberSchema,
  projectSchema,
  serviceStatusSchema,
  setupRequestSchema,
  setupResultSchema,
  setupStatusSchema,
  updateProjectRequestSchema,
  assignProjectMemberRequestSchema,
} from '@aeonic/contracts'
import type { AppConfig } from '../config.js'

export interface OpenApiDocument {
  openapi: '3.1.1'
  info: { title: string; version: string; description: string; license: { name: string } }
  jsonSchemaDialect: string
  servers: Array<{ url: string; description: string }>
  tags: Array<{ name: string; description: string }>
  paths: Record<string, Record<string, unknown>>
  components: Record<string, unknown>
}

function component<T extends { readonly $id: string }>(schema: T): Omit<T, '$id'> {
  const { $id: _id, ...value } = schema
  return value
}

const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const response = (name: string) => ({ $ref: `#/components/responses/${name}` })
const parameter = (name: string) => ({ $ref: `#/components/parameters/${name}` })
const cookieSecurity = [{ cookieAuth: [] }]

const jsonBody = (schemaName: string) => ({
  required: true,
  content: { 'application/json': { schema: schema(schemaName) } },
})

const jsonResponse = (
  description: string,
  schemaName: string,
  headers?: Record<string, unknown>,
) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { 'application/json': { schema: schema(schemaName) } },
})

const standardErrors = {
  '400': response('Problem'),
  '401': response('Problem'),
  '403': response('Problem'),
  '404': response('Problem'),
  '409': response('Problem'),
  '500': response('Problem'),
}

const authErrors = {
  '400': response('AuthError'),
  '401': response('AuthError'),
  '403': response('AuthError'),
  '404': response('AuthError'),
  '422': response('AuthError'),
}

const etagHeader = {
  ETag: {
    description: 'Strong entity tag required by subsequent update and delete requests.',
    schema: { type: 'string' },
  },
}

const projectCollectionPath = '/api/v1/organizations/{organizationId}/projects'
const projectItemPath = '/api/v1/organizations/{organizationId}/projects/{projectId}'
const memberCollectionPath = `${projectItemPath}/members`
const apiKeyCollectionPath = `${projectItemPath}/api-keys`

export function createOpenApiDocument(config: AppConfig): OpenApiDocument {
  return {
    openapi: '3.1.1',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Aeonic API',
      version: config.version,
      description:
        'Self-hosted media control-plane API. Routes not present in this document are not part of the supported public contract.',
      license: { name: 'MIT' },
    },
    servers: [{ url: config.authBaseUrl, description: 'Configured Aeonic server' }],
    tags: [
      { name: 'Health', description: 'Process liveness and dependency readiness.' },
      { name: 'Setup', description: 'One-time, race-safe instance initialization.' },
      { name: 'Authentication', description: 'Cookie-session authentication.' },
      { name: 'Organizations', description: 'Organization invitations and membership.' },
      { name: 'Projects', description: 'Tenant-isolated project management.' },
      { name: 'Project members', description: 'Project access assignments.' },
      { name: 'API keys', description: 'Project-scoped machine credentials.' },
      { name: 'Audit', description: 'Administrator-only audit history.' },
    ],
    paths: {
      '/health/live': {
        get: {
          operationId: 'getLiveness',
          tags: ['Health'],
          summary: 'Check process liveness',
          responses: { '200': jsonResponse('The process is alive.', 'ServiceStatus') },
        },
      },
      '/health/ready': {
        get: {
          operationId: 'getReadiness',
          tags: ['Health'],
          summary: 'Check service readiness',
          responses: {
            '200': jsonResponse('The service is ready.', 'ServiceStatus'),
            '503': response('Problem'),
          },
        },
      },
      '/api/v1/setup': {
        get: {
          operationId: 'getSetupStatus',
          tags: ['Setup'],
          summary: 'Check whether initial setup is required',
          responses: { '200': jsonResponse('Current setup status.', 'SetupStatus') },
        },
        post: {
          operationId: 'initializeInstance',
          tags: ['Setup'],
          summary: 'Create the first owner, organization, and project',
          requestBody: jsonBody('SetupRequest'),
          responses: {
            '201': jsonResponse('The instance was initialized.', 'SetupResult'),
            '400': response('Problem'),
            '409': response('Problem'),
            '500': response('Problem'),
          },
        },
      },
      '/api/auth/sign-up/email': {
        post: {
          operationId: 'signUpWithEmail',
          tags: ['Authentication'],
          summary: 'Create a user account and session',
          requestBody: jsonBody('EmailCredentialsWithName'),
          responses: {
            '200': jsonResponse('Account and session created.', 'AuthUserResult'),
            ...authErrors,
          },
        },
      },
      '/api/auth/sign-in/email': {
        post: {
          operationId: 'signInWithEmail',
          tags: ['Authentication'],
          summary: 'Create a cookie session',
          requestBody: jsonBody('EmailCredentials'),
          responses: {
            '200': jsonResponse('Session created.', 'AuthUserResult'),
            ...authErrors,
          },
        },
      },
      '/api/auth/get-session': {
        get: {
          operationId: 'getSession',
          tags: ['Authentication'],
          summary: 'Get the current cookie session',
          security: cookieSecurity,
          responses: {
            '200': {
              description: 'Current session, or null when signed out.',
              content: {
                'application/json': {
                  schema: { anyOf: [schema('AuthSessionResult'), { type: 'null' }] },
                },
              },
            },
          },
        },
      },
      '/api/auth/sign-out': {
        post: {
          operationId: 'signOut',
          tags: ['Authentication'],
          summary: 'End the current session',
          security: cookieSecurity,
          responses: { '200': jsonResponse('Session ended.', 'SuccessResult') },
        },
      },
      '/api/auth/organization/invite-member': {
        post: {
          operationId: 'inviteOrganizationMember',
          tags: ['Organizations'],
          summary: 'Create an organization invitation',
          security: cookieSecurity,
          requestBody: jsonBody('OrganizationInvitationRequest'),
          responses: {
            '200': jsonResponse('Invitation created.', 'OrganizationInvitation'),
            ...authErrors,
          },
        },
      },
      '/api/auth/organization/accept-invitation': {
        post: {
          operationId: 'acceptOrganizationInvitation',
          tags: ['Organizations'],
          summary: 'Accept an organization invitation',
          security: cookieSecurity,
          requestBody: jsonBody('InvitationActionRequest'),
          responses: {
            '200': jsonResponse('Invitation accepted.', 'InvitationAcceptedResult'),
            ...authErrors,
          },
        },
      },
      [projectCollectionPath]: {
        get: {
          operationId: 'listProjects',
          tags: ['Projects'],
          summary: 'List accessible projects',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId')],
          responses: {
            '200': jsonResponse('Accessible projects.', 'ProjectList'),
            ...standardErrors,
          },
        },
        post: {
          operationId: 'createProject',
          tags: ['Projects'],
          summary: 'Create a project',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId')],
          requestBody: jsonBody('CreateProjectRequest'),
          responses: {
            '201': jsonResponse('Project created.', 'Project', {
              ...etagHeader,
              Location: { description: 'URL of the created project.', schema: { type: 'string' } },
            }),
            ...standardErrors,
          },
        },
      },
      [projectItemPath]: {
        get: {
          operationId: 'getProject',
          tags: ['Projects'],
          summary: 'Get a project',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '200': jsonResponse('Project details.', 'Project', etagHeader),
            ...standardErrors,
          },
        },
        patch: {
          operationId: 'updateProject',
          tags: ['Projects'],
          summary: 'Update a project',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('IfMatch')],
          requestBody: jsonBody('UpdateProjectRequest'),
          responses: {
            '200': jsonResponse('Project updated.', 'Project', etagHeader),
            ...standardErrors,
            '412': response('Problem'),
            '428': response('Problem'),
          },
        },
        delete: {
          operationId: 'deleteProject',
          tags: ['Projects'],
          summary: 'Soft-delete a project',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('IfMatch')],
          responses: {
            '204': { description: 'Project deleted.' },
            ...standardErrors,
            '412': response('Problem'),
            '428': response('Problem'),
          },
        },
      },
      [memberCollectionPath]: {
        get: {
          operationId: 'listProjectMembers',
          tags: ['Project members'],
          summary: 'List project assignments',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '200': jsonResponse('Project assignments.', 'ProjectMemberList'),
            ...standardErrors,
          },
        },
        post: {
          operationId: 'assignProjectMember',
          tags: ['Project members'],
          summary: 'Assign an organization member to a project',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          requestBody: jsonBody('AssignProjectMemberRequest'),
          responses: {
            '201': jsonResponse('Member assigned.', 'ProjectMember'),
            ...standardErrors,
            '422': response('Problem'),
          },
        },
      },
      [`${memberCollectionPath}/{userId}`]: {
        delete: {
          operationId: 'removeProjectMember',
          tags: ['Project members'],
          summary: 'Remove a project assignment',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('UserId')],
          responses: { '204': { description: 'Assignment removed.' }, ...standardErrors },
        },
      },
      [apiKeyCollectionPath]: {
        get: {
          operationId: 'listProjectApiKeys',
          tags: ['API keys'],
          summary: 'List project API keys without secrets',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: { '200': jsonResponse('Project API keys.', 'ApiKeyList'), ...standardErrors },
        },
        post: {
          operationId: 'createProjectApiKey',
          tags: ['API keys'],
          summary: 'Create a project API key',
          description: 'The secret is returned once and is never stored in recoverable form.',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          requestBody: jsonBody('CreateApiKeyRequest'),
          responses: {
            '201': jsonResponse('API key created.', 'CreatedApiKey'),
            ...standardErrors,
          },
        },
      },
      [`${apiKeyCollectionPath}/{keyId}`]: {
        delete: {
          operationId: 'revokeProjectApiKey',
          tags: ['API keys'],
          summary: 'Revoke a project API key',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('ApiKeyId')],
          responses: { '204': { description: 'API key revoked.' }, ...standardErrors },
        },
      },
      '/api/v1/organizations/{organizationId}/audit-events': {
        get: {
          operationId: 'listAuditEvents',
          tags: ['Audit'],
          summary: 'List organization audit events',
          description: 'Restricted to organization owners and administrators.',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            { name: 'projectId', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': jsonResponse('Audit event page.', 'AuditEventList'),
            ...standardErrors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'better-auth.session_token',
          description: 'Better Auth session cookie. Secure deployments may add a cookie prefix.',
        },
        projectApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
          description: 'Reserved for project media APIs introduced in a later phase.',
        },
      },
      parameters: {
        OrganizationId: {
          name: 'organizationId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        ProjectId: {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        UserId: {
          name: 'userId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        ApiKeyId: {
          name: 'keyId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: true,
          schema: { type: 'string' },
          description: 'ETag returned by the latest project read or write.',
        },
      },
      responses: {
        Problem: {
          description: 'RFC 9457 problem details.',
          content: { 'application/problem+json': { schema: schema('ProblemDetails') } },
        },
        AuthError: {
          description: 'Authentication-provider error.',
          content: { 'application/json': { schema: schema('AuthError') } },
        },
      },
      schemas: {
        ProblemDetails: component(problemDetailsSchema),
        ServiceStatus: component(serviceStatusSchema),
        SetupStatus: component(setupStatusSchema),
        SetupRequest: component(setupRequestSchema),
        SetupResult: component(setupResultSchema),
        Project: component(projectSchema),
        ProjectList: component(projectListSchema),
        CreateProjectRequest: component(createProjectRequestSchema),
        UpdateProjectRequest: component(updateProjectRequestSchema),
        ProjectMember: component(projectMemberSchema),
        ProjectMemberList: component(projectMemberListSchema),
        AssignProjectMemberRequest: component(assignProjectMemberRequestSchema),
        ApiKeyList: component(apiKeyListSchema),
        CreateApiKeyRequest: component(createApiKeyRequestSchema),
        CreatedApiKey: component(createdApiKeySchema),
        AuditEventList: component(auditEventListSchema),
        EmailCredentials: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            password: { type: 'string', minLength: 8, maxLength: 128, format: 'password' },
          },
        },
        EmailCredentialsWithName: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'email', 'password'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            email: { type: 'string', format: 'email', maxLength: 320 },
            password: { type: 'string', minLength: 8, maxLength: 128, format: 'password' },
          },
        },
        AuthUser: {
          type: 'object',
          required: ['id', 'name', 'email', 'emailVerified', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            emailVerified: { type: 'boolean' },
            image: { type: ['string', 'null'], format: 'uri' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        AuthUserResult: {
          type: 'object',
          required: ['user'],
          properties: {
            user: schema('AuthUser'),
            token: { type: ['string', 'null'] },
          },
        },
        AuthSessionResult: {
          type: 'object',
          required: ['session', 'user'],
          properties: {
            session: {
              type: 'object',
              required: ['id', 'userId', 'expiresAt'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                userId: { type: 'string', format: 'uuid' },
                expiresAt: { type: 'string', format: 'date-time' },
                activeOrganizationId: { type: ['string', 'null'], format: 'uuid' },
              },
            },
            user: schema('AuthUser'),
          },
        },
        SuccessResult: {
          type: 'object',
          required: ['success'],
          properties: { success: { type: 'boolean', const: true } },
        },
        AuthError: {
          type: 'object',
          required: ['message'],
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
          },
        },
        OrganizationInvitationRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'role', 'organizationId'],
          properties: {
            email: { type: 'string', format: 'email' },
            role: { enum: ['owner', 'admin', 'developer', 'viewer'] },
            organizationId: { type: 'string', format: 'uuid' },
          },
        },
        InvitationActionRequest: {
          type: 'object',
          additionalProperties: false,
          required: ['invitationId'],
          properties: { invitationId: { type: 'string', format: 'uuid' } },
        },
        OrganizationInvitation: {
          type: 'object',
          required: ['id', 'organizationId', 'email', 'role', 'status', 'expiresAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            organizationId: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            role: { enum: ['owner', 'admin', 'developer', 'viewer'] },
            status: { enum: ['pending', 'accepted', 'rejected', 'cancelled'] },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        InvitationAcceptedResult: {
          type: 'object',
          required: ['invitation', 'member'],
          properties: {
            invitation: schema('OrganizationInvitation'),
            member: {
              type: 'object',
              required: ['id', 'organizationId', 'userId', 'role', 'createdAt'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                organizationId: { type: 'string', format: 'uuid' },
                userId: { type: 'string', format: 'uuid' },
                role: { enum: ['owner', 'admin', 'developer', 'viewer'] },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    },
  }
}
