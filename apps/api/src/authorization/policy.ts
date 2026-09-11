export type OrganizationRole = 'owner' | 'admin' | 'developer' | 'viewer'
export type ProjectAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'manage_api_keys'
  | 'read_audit'
  | 'upload'

const rolePriority: Record<OrganizationRole, number> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
}

const allowedActions: Record<OrganizationRole, readonly ProjectAction[]> = {
  owner: ['create', 'read', 'update', 'delete', 'manage_api_keys', 'read_audit', 'upload'],
  admin: ['create', 'read', 'update', 'delete', 'manage_api_keys', 'read_audit', 'upload'],
  developer: ['read', 'manage_api_keys', 'upload'],
  viewer: ['read'],
}

export function parseOrganizationRole(storedRole: string): OrganizationRole | null {
  const roles = storedRole
    .split(',')
    .filter((role): role is OrganizationRole => role in rolePriority)
  return roles.sort((left, right) => rolePriority[right] - rolePriority[left])[0] ?? null
}

export function roleAllows(role: OrganizationRole, action: ProjectAction): boolean {
  return allowedActions[role].includes(action)
}

export function roleHasOrganizationWideProjectAccess(role: OrganizationRole): boolean {
  return role === 'owner' || role === 'admin'
}
