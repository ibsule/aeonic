import type {
  ApiKeyList,
  Asset,
  AssetList,
  AuditEventList,
  CreatedApiKey,
  JobList,
  ProjectList,
  ProjectStorageOverview,
  SetupRequest,
  SetupResult,
  SetupStatus,
  SimpleUploadResult,
  TransformPresetList,
  UpdateAssetRequest,
} from '@aeonic/contracts'

export interface Session {
  session: { id: string }
  user: { id: string; email: string; name: string }
}

export interface Organization {
  id: string
  name: string
  slug: string
}

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body instanceof File || init.body instanceof Blob
        ? {}
        : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      code?: string
      detail?: string
      message?: string
    } | null
    throw new ApiProblem(
      response.status,
      problem?.code ?? 'request_failed',
      problem?.detail ?? problem?.message ?? 'The request could not be completed.',
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function projectPath(organizationId: string, projectId: string): string {
  return `/api/v1/organizations/${organizationId}/projects/${projectId}`
}

export const api = {
  setupStatus: () => request<SetupStatus>('/api/v1/setup'),
  setup: (input: SetupRequest) =>
    request<SetupResult>('/api/v1/setup', { method: 'POST', body: JSON.stringify(input) }),
  session: () => request<Session | null>('/api/auth/get-session'),
  signIn: (email: string, password: string) =>
    request<Session>('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signOut: () => request<void>('/api/auth/sign-out', { method: 'POST', body: '{}' }),
  organizations: () => request<Organization[]>('/api/auth/organization/list'),
  projects: (organizationId: string) =>
    request<ProjectList>(`/api/v1/organizations/${organizationId}/projects`),
  createProject: (organizationId: string, name: string, slug: string) =>
    request<{ id: string; name: string; slug: string }>(
      `/api/v1/organizations/${organizationId}/projects`,
      { method: 'POST', body: JSON.stringify({ name, slug }) },
    ),
  assets: (organizationId: string, projectId: string, query = '') =>
    request<AssetList>(`${projectPath(organizationId, projectId)}/assets?limit=100${query}`),
  asset: async (organizationId: string, projectId: string, publicId: string) => {
    const response = await fetch(`${projectPath(organizationId, projectId)}/assets/${publicId}`, {
      credentials: 'same-origin',
    })
    if (!response.ok) {
      throw new ApiProblem(response.status, 'asset_load_failed', 'The asset could not be loaded.')
    }
    return { asset: (await response.json()) as Asset, etag: response.headers.get('etag') ?? '' }
  },
  updateAsset: (
    organizationId: string,
    projectId: string,
    publicId: string,
    etag: string,
    input: UpdateAssetRequest,
  ) =>
    request<Asset>(`${projectPath(organizationId, projectId)}/assets/${publicId}`, {
      method: 'PATCH',
      headers: { 'if-match': etag },
      body: JSON.stringify(input),
    }),
  upload: (
    organizationId: string,
    projectId: string,
    file: File,
    name: string,
    folder: string,
    visibility: 'private' | 'public',
  ) => {
    const params = new URLSearchParams({ filename: file.name, name, folder, visibility })
    return request<SimpleUploadResult>(
      `${projectPath(organizationId, projectId)}/uploads?${params}`,
      {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: file,
      },
    )
  },
  storage: (organizationId: string, projectId: string) =>
    request<ProjectStorageOverview>(`${projectPath(organizationId, projectId)}/storage`),
  jobs: (organizationId: string, projectId: string) =>
    request<JobList>(`${projectPath(organizationId, projectId)}/jobs?limit=100`),
  presets: (organizationId: string, projectId: string) =>
    request<TransformPresetList>(
      `${projectPath(organizationId, projectId)}/transform-presets?limit=100`,
    ),
  createPreset: (organizationId: string, projectId: string, name: string, transform: string) =>
    request(`${projectPath(organizationId, projectId)}/transform-presets`, {
      method: 'POST',
      body: JSON.stringify({ name, transform }),
    }),
  apiKeys: (organizationId: string, projectId: string) =>
    request<ApiKeyList>(`${projectPath(organizationId, projectId)}/api-keys`),
  createApiKey: (organizationId: string, projectId: string, name: string) =>
    request<CreatedApiKey>(`${projectPath(organizationId, projectId)}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        scopes: ['projects:read', 'assets:read', 'assets:write', 'jobs:read'],
      }),
    }),
  revokeApiKey: (organizationId: string, projectId: string, keyId: string) =>
    request<void>(`${projectPath(organizationId, projectId)}/api-keys/${keyId}`, {
      method: 'DELETE',
    }),
  audit: (organizationId: string, projectId: string) =>
    request<AuditEventList>(
      `/api/v1/organizations/${organizationId}/audit-events?projectId=${projectId}&limit=100`,
    ),
}
