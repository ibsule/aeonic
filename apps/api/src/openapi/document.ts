import {
  agentApprovalInboxSchema,
  agentRunSchema,
  aiIndexSchema,
  apiKeyListSchema,
  assetListSchema,
  assetSchema,
  assignProjectMemberRequestSchema,
  auditEventListSchema,
  approvalDecisionRequestSchema,
  approvalRequestSchema,
  cancelAgentRunRequestSchema,
  consumeApprovalRequestSchema,
  createApiKeyRequestSchema,
  createDeliveryUrlRequestSchema,
  createDerivativeRequestSchema,
  createdApiKeySchema,
  createProjectRequestSchema,
  createTransformPresetRequestSchema,
  createTransformPresetVersionRequestSchema,
  deliveryUrlSchema,
  derivativeSchema,
  jobListSchema,
  jobSchema,
  problemDetailsSchema,
  projectListSchema,
  projectMemberListSchema,
  projectMemberSchema,
  projectSchema,
  projectStorageOverviewSchema,
  semanticSearchResponseSchema,
  semanticSearchSettingsSchema,
  serviceStatusSchema,
  setupRequestSchema,
  setupResultSchema,
  setupStatusSchema,
  simpleUploadResultSchema,
  startSemanticReindexRequestSchema,
  storageFailureSummarySchema,
  transformPresetListSchema,
  transformPresetSchema,
  updateAssetAiExclusionRequestSchema,
  updateAssetRequestSchema,
  updateProjectRequestSchema,
  updateSemanticSearchSettingsRequestSchema,
  uploadQuerySchema,
} from '@aeonic/contracts'
import type { AppConfig } from '../config.js'

export interface OpenApiDocument {
  openapi: '3.1.2'
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
const projectReadSecurity = [{ cookieAuth: [] }, { projectApiKey: [] }]

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

const deliveryHeaders = {
  'Accept-Ranges': {
    description: 'Indicates support for a single byte range.',
    schema: { type: 'string', const: 'bytes' },
  },
  'Content-Disposition': {
    description: 'Safe inline or attachment disposition with an encoded filename.',
    schema: { type: 'string' },
  },
  'Content-Length': { schema: { type: 'integer', minimum: 0 } },
  'Cache-Control': { schema: { type: 'string' } },
  ETag: { description: 'Strong validator for the immutable version.', schema: { type: 'string' } },
  'Last-Modified': { schema: { type: 'string' } },
}

const originalResponse = (description: string) => ({
  description,
  headers: deliveryHeaders,
  content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
})

const originalResponses = {
  '200': originalResponse('Complete immutable original.'),
  '206': {
    ...originalResponse('Requested byte range.'),
    headers: {
      ...deliveryHeaders,
      'Content-Range': { schema: { type: 'string', pattern: '^bytes [0-9]+-[0-9]+/[0-9]+$' } },
    },
  },
  '304': { description: 'The client validator still matches.' },
  '416': {
    ...response('Problem'),
    headers: {
      'Content-Range': { schema: { type: 'string', pattern: '^bytes \\*/[0-9]+$' } },
    },
  },
  '503': response('Problem'),
}

const projectCollectionPath = '/api/v1/organizations/{organizationId}/projects'
const projectItemPath = '/api/v1/organizations/{organizationId}/projects/{projectId}'
const memberCollectionPath = `${projectItemPath}/members`
const apiKeyCollectionPath = `${projectItemPath}/api-keys`
const uploadCollectionPath = `${projectItemPath}/uploads`
const assetCollectionPath = `${projectItemPath}/assets`
const assetItemPath = `${assetCollectionPath}/{publicId}`
const assetVersionPath = `${projectItemPath}/assets/{publicId}/versions/{version}`
const jobCollectionPath = `${projectItemPath}/jobs`
const jobItemPath = `${jobCollectionPath}/{jobId}`
const deliveryUrlPath = `${assetVersionPath}/delivery-url`
const authenticatedOriginalPath = `${assetVersionPath}/original`
const publicOriginalPath = '/m/{projectId}/{publicId}/v{version}/original/{filename}'
const authenticatedTransformPath = `${assetVersionPath}/t/{transformSpec}`
const derivativeCollectionPath = `${assetVersionPath}/derivatives`
const derivativeItemPath = `${projectItemPath}/derivatives/{derivativeId}`
const derivativeContentPath = `${derivativeItemPath}/content`
const publicTransformPath = '/m/{projectId}/{publicId}/v{version}/t/{transformSpec}/{filename}'
const tusCollectionPath = `${projectItemPath}/tus`
const tusItemPath = `${tusCollectionPath}/{uploadId}`
const storageOverviewPath = `${projectItemPath}/storage`
const transformPresetCollectionPath = `${projectItemPath}/transform-presets`
const transformPresetVersionCollectionPath = `${transformPresetCollectionPath}/{presetName}/versions`
const transformPresetVersionPath = `${transformPresetVersionCollectionPath}/{presetVersion}`
const agentApprovalCollectionPath = `${projectItemPath}/agent-approvals`
const agentApprovalItemPath = `${agentApprovalCollectionPath}/{approvalId}`
const agentRunItemPath = `${projectItemPath}/agent-runs/{runId}`

const tusResponseHeaders = {
  'Tus-Resumable': { schema: { type: 'string', const: '1.0.0' } },
  'Tus-Version': { schema: { type: 'string', const: '1.0.0' } },
  'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
  'Upload-Length': { schema: { type: 'integer', minimum: 1 } },
  'Upload-Expires': { schema: { type: 'string' } },
  'Upload-Asset-Id': { schema: { type: 'string', format: 'uuid' } },
  'Upload-Public-Id': { schema: { type: 'string', format: 'uuid' } },
}

export function createOpenApiDocument(config: AppConfig): OpenApiDocument {
  return {
    openapi: '3.1.2',
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
      { name: 'Uploads', description: 'Bounded, tenant-isolated media ingestion.' },
      { name: 'Assets', description: 'Searchable media catalog and asset metadata.' },
      { name: 'Jobs', description: 'Project-scoped background work and failure status.' },
      { name: 'Resumable uploads', description: 'Authenticated tus 1.0 media ingestion.' },
      { name: 'Storage', description: 'Project usage, quota, and backend diagnostics.' },
      { name: 'Delivery', description: 'Authorized original-asset streaming and sharing.' },
      {
        name: 'Transform presets',
        description: 'Named and permanently versioned canonical image transformations.',
      },
      {
        name: 'Derivatives',
        description: 'Durable asynchronous video and document processing.',
      },
      {
        name: 'Semantic search',
        description: 'Optional, budgeted, project-isolated hybrid media retrieval.',
      },
      {
        name: 'Agent workflows',
        description: 'Approval-gated, exact-target media workflow plans and execution status.',
      },
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
      [uploadCollectionPath]: {
        post: {
          operationId: 'createSimpleUpload',
          tags: ['Uploads'],
          summary: 'Stream one media file into a processing asset',
          description:
            'Requires an exact Content-Length. The declared media type, filename extension, and detected binary signature must agree. Accepted assets remain processing until a media worker completes decoder-level inspection.',
          security: [{ cookieAuth: [] }, { projectApiKey: [] }],
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            {
              name: 'filename',
              in: 'query',
              required: true,
              schema: uploadQuerySchema.properties.filename,
            },
            { name: 'name', in: 'query', schema: uploadQuerySchema.properties.name },
            { name: 'folder', in: 'query', schema: uploadQuerySchema.properties.folder },
            { name: 'visibility', in: 'query', schema: uploadQuerySchema.properties.visibility },
            {
              name: 'Content-Length',
              in: 'header',
              required: true,
              schema: { type: 'integer', minimum: 1, maximum: config.uploadMaxBytes },
            },
            {
              name: 'Content-Digest',
              in: 'header',
              schema: { type: 'string', pattern: '^sha-256=:[A-Za-z0-9+/]{43}=:$' },
              description: 'Optional SHA-256 digest using RFC 9530 binary syntax.',
            },
            {
              name: 'Idempotency-Key',
              in: 'header',
              schema: { type: 'string', minLength: 8, maxLength: 128 },
            },
          ],
          requestBody: {
            required: true,
            content: Object.fromEntries(
              [
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
                'image/avif',
                'video/mp4',
                'video/webm',
                'video/quicktime',
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              ].map((mimeType) => [mimeType, { schema: { type: 'string', format: 'binary' } }]),
            ),
          },
          responses: {
            '200': jsonResponse(
              'A completed idempotent upload was replayed.',
              'SimpleUploadResult',
              {
                'Idempotency-Replayed': {
                  description: 'Always true for this response.',
                  schema: { type: 'string', const: 'true' },
                },
              },
            ),
            '201': jsonResponse(
              'The file was stored and queued for inspection.',
              'SimpleUploadResult',
            ),
            ...standardErrors,
            '411': response('Problem'),
            '413': response('Problem'),
            '415': response('Problem'),
            '422': response('Problem'),
            '503': response('Problem'),
          },
        },
      },
      [assetCollectionPath]: {
        get: {
          operationId: 'listAssets',
          tags: ['Assets'],
          summary: 'Search and filter project assets',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            { name: 'query', in: 'query', schema: { type: 'string', minLength: 1 } },
            {
              name: 'mediaKind',
              in: 'query',
              schema: { type: 'string', enum: ['image', 'video', 'document'] },
            },
            {
              name: 'state',
              in: 'query',
              schema: assetSchema.properties.state,
            },
            {
              name: 'visibility',
              in: 'query',
              schema: assetSchema.properties.visibility,
            },
            { name: 'cursor', in: 'query', schema: { type: 'string', minLength: 1 } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': jsonResponse('Matching project assets.', 'AssetList'),
            ...standardErrors,
          },
        },
      },
      [assetItemPath]: {
        get: {
          operationId: 'getAsset',
          tags: ['Assets'],
          summary: 'Get current asset metadata',
          security: projectReadSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('PublicId')],
          responses: {
            '200': jsonResponse('Current asset metadata.', 'Asset', etagHeader),
            ...standardErrors,
          },
        },
        patch: {
          operationId: 'updateAsset',
          tags: ['Assets'],
          summary: 'Update asset metadata or privacy',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('IfMatch'),
          ],
          requestBody: jsonBody('UpdateAssetRequest'),
          responses: {
            '200': jsonResponse('Updated asset metadata.', 'Asset', etagHeader),
            ...standardErrors,
            '412': response('Problem'),
            '428': response('Problem'),
          },
        },
      },
      [jobCollectionPath]: {
        get: {
          operationId: 'listJobs',
          tags: ['Jobs'],
          summary: 'List background work and its progress',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            { name: 'state', in: 'query', schema: jobSchema.properties.state },
            { name: 'cursor', in: 'query', schema: { type: 'string', minLength: 1 } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': jsonResponse('Project jobs ordered newest first.', 'JobList'),
            ...standardErrors,
          },
        },
      },
      [jobItemPath]: {
        get: {
          operationId: 'getJob',
          tags: ['Jobs'],
          summary: 'Get one background job',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            {
              name: 'jobId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': jsonResponse('Current job status.', 'Job'),
            ...standardErrors,
          },
        },
      },
      [tusCollectionPath]: {
        options: {
          operationId: 'discoverTusCapabilities',
          tags: ['Resumable uploads'],
          summary: 'Discover supported tus protocol capabilities',
          security: [],
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '204': {
              description: 'Tus 1.0 capability advertisement.',
              headers: {
                ...tusResponseHeaders,
                'Tus-Extension': {
                  schema: {
                    type: 'string',
                    const: 'creation,expiration,checksum,termination',
                  },
                },
                'Tus-Max-Size': {
                  schema: { type: 'integer', const: config.tusUploadMaxBytes },
                },
                'Tus-Checksum-Algorithm': {
                  schema: { type: 'string', const: 'sha1,sha256' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createTusUpload',
          tags: ['Resumable uploads'],
          summary: 'Create a resumable media upload',
          description:
            'Implements tus 1.0 creation with fixed length. Upload-Metadata requires Base64-encoded filename and filetype values. Creation-with-upload and deferred length are not supported.',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('TusResumable'),
            parameter('UploadLength'),
            parameter('UploadMetadata'),
          ],
          responses: {
            '201': {
              description: 'Resumable upload created.',
              headers: {
                ...tusResponseHeaders,
                Location: { schema: { type: 'string', format: 'uri-reference' } },
              },
            },
            ...standardErrors,
            '412': response('Problem'),
            '413': response('Problem'),
            '415': response('Problem'),
          },
        },
      },
      [tusItemPath]: {
        head: {
          operationId: 'getTusUploadOffset',
          tags: ['Resumable uploads'],
          summary: 'Get the durable resumable-upload offset',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('UploadId'),
            parameter('TusResumable'),
          ],
          responses: {
            '200': {
              description: 'Current upload offset and metadata.',
              headers: tusResponseHeaders,
            },
            ...standardErrors,
            '410': response('Problem'),
            '412': response('Problem'),
          },
        },
        patch: {
          operationId: 'appendTusUpload',
          tags: ['Resumable uploads'],
          summary: 'Append a chunk at the current upload offset',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('UploadId'),
            parameter('TusResumable'),
            parameter('UploadOffset'),
            parameter('UploadChecksum'),
          ],
          requestBody: {
            required: true,
            content: {
              'application/offset+octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          responses: {
            '204': { description: 'Chunk stored successfully.', headers: tusResponseHeaders },
            ...standardErrors,
            '410': response('Problem'),
            '412': response('Problem'),
            '413': response('Problem'),
            '415': response('Problem'),
            '460': response('Problem'),
          },
        },
        delete: {
          operationId: 'terminateTusUpload',
          tags: ['Resumable uploads'],
          summary: 'Terminate a resumable upload resource',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('UploadId'),
            parameter('TusResumable'),
          ],
          responses: {
            '204': { description: 'Upload resource terminated.', headers: tusResponseHeaders },
            ...standardErrors,
            '410': response('Problem'),
            '412': response('Problem'),
          },
        },
      },
      [storageOverviewPath]: {
        get: {
          operationId: 'getProjectStorageOverview',
          tags: ['Storage'],
          summary: 'Get project usage, quota, backend health, and failure classifications',
          security: projectReadSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '200': jsonResponse('Current project storage overview.', 'ProjectStorageOverview'),
            ...standardErrors,
            '503': response('Problem'),
          },
        },
      },
      [transformPresetCollectionPath]: {
        get: {
          operationId: 'listTransformPresets',
          tags: ['Transform presets'],
          summary: 'List every immutable transform-preset version in a project',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            { name: 'cursor', in: 'query', schema: { type: 'string', format: 'uuid' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': jsonResponse('Project transform presets.', 'TransformPresetList'),
            ...standardErrors,
          },
        },
        post: {
          operationId: 'createTransformPreset',
          tags: ['Transform presets'],
          summary: 'Create the first immutable version of a named transform preset',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          requestBody: jsonBody('CreateTransformPresetRequest'),
          responses: {
            '201': jsonResponse('Transform preset created.', 'TransformPreset', {
              Location: { schema: { type: 'string', format: 'uri-reference' } },
            }),
            ...standardErrors,
          },
        },
      },
      [transformPresetVersionCollectionPath]: {
        post: {
          operationId: 'createTransformPresetVersion',
          tags: ['Transform presets'],
          summary: 'Create the next immutable version of a transform preset',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PresetName'),
          ],
          requestBody: jsonBody('CreateTransformPresetVersionRequest'),
          responses: {
            '201': jsonResponse('Transform preset version created.', 'TransformPreset', {
              Location: { schema: { type: 'string', format: 'uri-reference' } },
            }),
            ...standardErrors,
          },
        },
      },
      [transformPresetVersionPath]: {
        get: {
          operationId: 'getTransformPresetVersion',
          tags: ['Transform presets'],
          summary: 'Get one exact immutable transform-preset version',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PresetName'),
            parameter('PresetVersion'),
          ],
          responses: {
            '200': jsonResponse('Exact transform preset version.', 'TransformPreset'),
            ...standardErrors,
          },
        },
      },
      [deliveryUrlPath]: {
        post: {
          operationId: 'createOriginalDeliveryUrl',
          tags: ['Delivery'],
          summary: 'Create a temporary original-asset URL',
          description:
            'Creates a tamper-resistant capability URL for one ready asset version. Private assets remain inaccessible without its unexpired signature.',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
          ],
          requestBody: jsonBody('CreateDeliveryUrlRequest'),
          responses: {
            '201': jsonResponse('Temporary delivery URL created.', 'DeliveryUrl'),
            ...standardErrors,
          },
        },
      },
      [authenticatedOriginalPath]: {
        get: {
          operationId: 'getAuthenticatedOriginal',
          tags: ['Delivery'],
          summary: 'Download an original asset with project credentials',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('Disposition'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, ...standardErrors },
        },
        head: {
          operationId: 'headAuthenticatedOriginal',
          tags: ['Delivery'],
          summary: 'Inspect original-asset response metadata with project credentials',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('Disposition'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, ...standardErrors },
        },
      },
      [publicOriginalPath]: {
        get: {
          operationId: 'getOriginalByUrl',
          tags: ['Delivery'],
          summary: 'Download an original asset by canonical URL',
          description:
            'Public assets need no query signature. Private assets require the complete unmodified signed query returned by the delivery-URL endpoint.',
          security: [],
          parameters: [
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('Filename'),
            parameter('Disposition'),
            parameter('DeliveryExpires'),
            parameter('DeliveryKeyId'),
            parameter('DeliverySignature'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, '404': response('Problem') },
        },
        head: {
          operationId: 'headOriginalByUrl',
          tags: ['Delivery'],
          summary: 'Inspect canonical original-asset response metadata',
          security: [],
          parameters: [
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('Filename'),
            parameter('Disposition'),
            parameter('DeliveryExpires'),
            parameter('DeliveryKeyId'),
            parameter('DeliverySignature'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, '404': response('Problem') },
        },
      },
      [authenticatedTransformPath]: {
        get: {
          operationId: 'getAuthenticatedImageTransform',
          tags: ['Delivery'],
          summary: 'Generate or download an image derivative with project credentials',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('TransformSpec'),
            parameter('Disposition'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, ...standardErrors },
        },
        head: {
          operationId: 'headAuthenticatedImageTransform',
          tags: ['Delivery'],
          summary: 'Inspect image-derivative response metadata with project credentials',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('TransformSpec'),
            parameter('Disposition'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, ...standardErrors },
        },
      },
      [derivativeCollectionPath]: {
        post: {
          operationId: 'createDerivative',
          tags: ['Derivatives'],
          summary: 'Queue a video or document derivative',
          description:
            'Canonicalizes the request and reuses matching work. A ready cache hit returns 200; queued or active work returns 202.',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
          ],
          requestBody: jsonBody('CreateDerivativeRequest'),
          responses: {
            '200': jsonResponse('Existing ready derivative.', 'Derivative'),
            '202': jsonResponse('Derivative accepted for processing.', 'Derivative'),
            ...standardErrors,
            '415': response('Problem'),
          },
        },
      },
      [derivativeItemPath]: {
        get: {
          operationId: 'getDerivative',
          tags: ['Derivatives'],
          summary: 'Get asynchronous derivative status',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('DerivativeId'),
          ],
          responses: { '200': jsonResponse('Derivative status.', 'Derivative'), ...standardErrors },
        },
        delete: {
          operationId: 'invalidateDerivative',
          tags: ['Derivatives'],
          summary: 'Invalidate and remove a cached derivative',
          description:
            'Cancels queued work and removes completed bytes. Active leased work must finish or expire first.',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('DerivativeId'),
          ],
          responses: { '204': { description: 'Derivative invalidated.' }, ...standardErrors },
        },
      },
      [derivativeContentPath]: {
        get: {
          operationId: 'getDerivativeContent',
          tags: ['Derivatives'],
          summary: 'Download a completed asynchronous derivative',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('DerivativeId'),
          ],
          responses: {
            '200': {
              description: 'Completed derivative bytes.',
              content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
            },
            ...standardErrors,
            '503': response('Problem'),
          },
        },
        head: {
          operationId: 'headDerivativeContent',
          tags: ['Derivatives'],
          summary: 'Inspect completed asynchronous derivative metadata',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('DerivativeId'),
          ],
          responses: {
            '200': { description: 'Completed derivative metadata.' },
            ...standardErrors,
          },
        },
      },
      [publicTransformPath]: {
        get: {
          operationId: 'getImageTransformByUrl',
          tags: ['Delivery'],
          summary: 'Generate or download an image derivative by canonical URL',
          description:
            'Automatic formats negotiate through Accept and return Vary: Accept. Private assets require the complete signed query.',
          security: [],
          parameters: [
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('TransformSpec'),
            parameter('Filename'),
            parameter('Disposition'),
            parameter('DeliveryExpires'),
            parameter('DeliveryKeyId'),
            parameter('DeliverySignature'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, '404': response('Problem') },
        },
        head: {
          operationId: 'headImageTransformByUrl',
          tags: ['Delivery'],
          summary: 'Inspect canonical image-derivative response metadata',
          security: [],
          parameters: [
            parameter('ProjectId'),
            parameter('PublicId'),
            parameter('Version'),
            parameter('TransformSpec'),
            parameter('Filename'),
            parameter('Disposition'),
            parameter('DeliveryExpires'),
            parameter('DeliveryKeyId'),
            parameter('DeliverySignature'),
            parameter('Range'),
            parameter('IfNoneMatch'),
            parameter('IfModifiedSince'),
            parameter('IfRange'),
          ],
          responses: { ...originalResponses, '404': response('Problem') },
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
      [`${projectItemPath}/semantic/settings`]: {
        get: {
          operationId: 'getSemanticSearchSettings',
          tags: ['Semantic search'],
          summary: 'Inspect semantic-search availability, usage, and project controls',
          security: projectReadSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '200': jsonResponse('Semantic-search settings.', 'SemanticSearchSettings'),
            ...standardErrors,
          },
        },
        patch: {
          operationId: 'updateSemanticSearchSettings',
          tags: ['Semantic search'],
          summary: 'Update opt-in, privacy, budget, and indexing limits',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          requestBody: jsonBody('UpdateSemanticSearchSettingsRequest'),
          responses: {
            '200': jsonResponse('Updated semantic-search settings.', 'SemanticSearchSettings'),
            ...standardErrors,
          },
        },
      },
      [`${projectItemPath}/semantic/reindex`]: {
        post: {
          operationId: 'startSemanticReindex',
          tags: ['Semantic search'],
          summary: 'Build and evaluate a side-by-side candidate index',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          requestBody: jsonBody('StartSemanticReindexRequest'),
          responses: {
            '202': jsonResponse('Candidate index queued.', 'AiIndex'),
            ...standardErrors,
          },
        },
      },
      [`${projectItemPath}/search`]: {
        get: {
          operationId: 'searchProjectMedia',
          tags: ['Semantic search'],
          summary: 'Search media with local lexical and optional semantic retrieval',
          security: projectReadSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            {
              name: 'query',
              in: 'query',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 500 },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
          ],
          responses: {
            '200': jsonResponse('Ranked project media.', 'SemanticSearchResponse'),
            ...standardErrors,
          },
        },
      },
      [`${assetItemPath}/ai-exclusion`]: {
        put: {
          operationId: 'setAssetAiExclusion',
          tags: ['Semantic search'],
          summary: 'Exclude or restore an asset for future AI indexing',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId'), parameter('PublicId')],
          requestBody: jsonBody('UpdateAssetAiExclusionRequest'),
          responses: {
            '204': { description: 'Exclusion updated and vector cleanup queued.' },
            ...standardErrors,
          },
        },
      },
      [`${projectItemPath}/semantic/indexes/{indexId}`]: {
        delete: {
          operationId: 'deleteSemanticIndex',
          tags: ['Semantic search'],
          summary: 'Delete an index and queue vector collection cleanup',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            {
              name: 'indexId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '204': { description: 'Index deleted and vector cleanup queued.' },
            ...standardErrors,
          },
        },
      },
      [agentApprovalCollectionPath]: {
        get: {
          operationId: 'listAgentApprovals',
          tags: ['Agent workflows'],
          summary: 'List agent plans awaiting an administrator action',
          description:
            'Returns frozen plan hashes, exact target snapshots, effects, risk, and current run state. Restricted to organization owners and administrators.',
          security: cookieSecurity,
          parameters: [parameter('OrganizationId'), parameter('ProjectId')],
          responses: {
            '200': jsonResponse('Actionable approval inbox.', 'AgentApprovalInbox'),
            ...standardErrors,
          },
        },
      },
      [`${agentApprovalItemPath}/decision`]: {
        post: {
          operationId: 'decideAgentApproval',
          tags: ['Agent workflows'],
          summary: 'Approve or reject one exact frozen plan',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('ApprovalId'),
          ],
          requestBody: jsonBody('ApprovalDecisionRequest'),
          responses: {
            '200': jsonResponse('Recorded approval decision.', 'ApprovalRequest'),
            ...standardErrors,
          },
        },
      },
      [`${agentApprovalItemPath}/execute`]: {
        post: {
          operationId: 'executeApprovedAgentPlan',
          tags: ['Agent workflows'],
          summary: 'Consume an approval and queue its exact plan once',
          description:
            'The supplied hash must equal the reviewed immutable plan. Targets are revalidated both when queueing and immediately before mutation.',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('ApprovalId'),
          ],
          requestBody: jsonBody('ConsumeApprovalRequest'),
          responses: {
            '202': jsonResponse('Approved run queued for execution.', 'AgentRun'),
            ...standardErrors,
          },
        },
      },
      [agentRunItemPath]: {
        get: {
          operationId: 'getAgentRun',
          tags: ['Agent workflows'],
          summary: 'Get approval-gated agent run status',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('AgentRunId'),
          ],
          responses: { '200': jsonResponse('Agent run status.', 'AgentRun'), ...standardErrors },
        },
      },
      [`${agentRunItemPath}/cancel`]: {
        post: {
          operationId: 'cancelAgentRun',
          tags: ['Agent workflows'],
          summary: 'Cancel a non-terminal agent run and its queued work',
          security: cookieSecurity,
          parameters: [
            parameter('OrganizationId'),
            parameter('ProjectId'),
            parameter('AgentRunId'),
          ],
          requestBody: jsonBody('CancelAgentRunRequest'),
          responses: {
            '200': jsonResponse('Cancelled agent run.', 'AgentRun'),
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
          description: 'Project-scoped credential for upload and original-delivery APIs.',
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
        PublicId: {
          name: 'publicId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        Version: {
          name: 'version',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1 },
        },
        Filename: {
          name: 'filename',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 255 },
        },
        UploadId: {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        DerivativeId: {
          name: 'derivativeId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        TusResumable: {
          name: 'Tus-Resumable',
          in: 'header',
          required: true,
          schema: { type: 'string', const: '1.0.0' },
        },
        UploadLength: {
          name: 'Upload-Length',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 1, maximum: config.tusUploadMaxBytes },
        },
        UploadOffset: {
          name: 'Upload-Offset',
          in: 'header',
          required: true,
          schema: { type: 'integer', minimum: 0 },
        },
        UploadMetadata: {
          name: 'Upload-Metadata',
          in: 'header',
          required: true,
          schema: { type: 'string', maxLength: 4096 },
        },
        UploadChecksum: {
          name: 'Upload-Checksum',
          in: 'header',
          schema: { type: 'string', pattern: '^(sha1|sha256) [A-Za-z0-9+/]+={0,2}$' },
        },
        Disposition: {
          name: 'disposition',
          in: 'query',
          schema: createDeliveryUrlRequestSchema.properties.disposition,
        },
        TransformSpec: {
          name: 'transformSpec',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          description: 'Canonical inline transform or immutable preset selector.',
        },
        DeliveryExpires: {
          name: 'expires',
          in: 'query',
          schema: { type: 'integer', minimum: 1 },
          description: 'Opaque signed-URL expiry. Use the value returned by the API unchanged.',
        },
        DeliveryKeyId: {
          name: 'kid',
          in: 'query',
          schema: { type: 'string' },
          description:
            'Opaque signing-key identifier. Use the value returned by the API unchanged.',
        },
        DeliverySignature: {
          name: 'signature',
          in: 'query',
          schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
          description: 'Opaque URL signature. Treat the complete signed URL as a bearer secret.',
        },
        Range: {
          name: 'Range',
          in: 'header',
          schema: { type: 'string', pattern: '^bytes=' },
          description: 'One byte range. Multipart ranges are not supported.',
        },
        IfNoneMatch: {
          name: 'If-None-Match',
          in: 'header',
          schema: { type: 'string' },
        },
        IfModifiedSince: {
          name: 'If-Modified-Since',
          in: 'header',
          schema: { type: 'string' },
        },
        IfRange: {
          name: 'If-Range',
          in: 'header',
          schema: { type: 'string' },
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
        ApprovalId: {
          name: 'approvalId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        AgentRunId: {
          name: 'runId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        PresetName: {
          name: 'presetName',
          in: 'path',
          required: true,
          schema: createTransformPresetRequestSchema.properties.name,
        },
        PresetVersion: {
          name: 'presetVersion',
          in: 'path',
          required: true,
          schema: { type: 'integer', minimum: 1 },
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
        UploadQuery: component(uploadQuerySchema),
        SimpleUploadResult: component(simpleUploadResultSchema),
        Asset: assetSchema,
        AssetList: component(assetListSchema),
        UpdateAssetRequest: component(updateAssetRequestSchema),
        Job: jobSchema,
        JobList: component(jobListSchema),
        CreateDerivativeRequest: component(createDerivativeRequestSchema),
        Derivative: component(derivativeSchema),
        CreateDeliveryUrlRequest: component(createDeliveryUrlRequestSchema),
        DeliveryUrl: component(deliveryUrlSchema),
        StorageFailureSummary: component(storageFailureSummarySchema),
        ProjectStorageOverview: component(projectStorageOverviewSchema),
        CreateTransformPresetRequest: component(createTransformPresetRequestSchema),
        CreateTransformPresetVersionRequest: component(createTransformPresetVersionRequestSchema),
        TransformPreset: component(transformPresetSchema),
        TransformPresetList: component(transformPresetListSchema),
        AiIndex: aiIndexSchema,
        SemanticSearchSettings: component(semanticSearchSettingsSchema),
        UpdateSemanticSearchSettingsRequest: component(updateSemanticSearchSettingsRequestSchema),
        StartSemanticReindexRequest: startSemanticReindexRequestSchema,
        UpdateAssetAiExclusionRequest: updateAssetAiExclusionRequestSchema,
        SemanticSearchResponse: component(semanticSearchResponseSchema),
        AgentApprovalInbox: component(agentApprovalInboxSchema),
        AgentRun: component(agentRunSchema),
        ApprovalRequest: component(approvalRequestSchema),
        ApprovalDecisionRequest: component(approvalDecisionRequestSchema),
        ConsumeApprovalRequest: component(consumeApprovalRequestSchema),
        CancelAgentRunRequest: component(cancelAgentRunRequestSchema),
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
