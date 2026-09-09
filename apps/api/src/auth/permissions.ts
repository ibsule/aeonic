import { createAccessControl } from 'better-auth/plugins/access'
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access'

export const accessStatements = {
  ...defaultStatements,
  project: ['create', 'read', 'update', 'delete'],
  asset: ['create', 'read', 'update', 'delete'],
  apiKey: ['create', 'read', 'update', 'delete'],
  audit: ['read'],
  agent: ['approve'],
} as const

export const accessControl = createAccessControl(accessStatements)

export const ownerRole = accessControl.newRole({
  ...ownerAc.statements,
  project: ['create', 'read', 'update', 'delete'],
  asset: ['create', 'read', 'update', 'delete'],
  apiKey: ['create', 'read', 'update', 'delete'],
  audit: ['read'],
  agent: ['approve'],
})

export const adminRole = accessControl.newRole({
  ...adminAc.statements,
  project: ['create', 'read', 'update', 'delete'],
  asset: ['create', 'read', 'update', 'delete'],
  apiKey: ['create', 'read', 'update', 'delete'],
  audit: ['read'],
  agent: ['approve'],
})

export const developerRole = accessControl.newRole({
  ...memberAc.statements,
  project: ['read'],
  asset: ['create', 'read', 'update', 'delete'],
  apiKey: ['create', 'read', 'update', 'delete'],
})

export const viewerRole = accessControl.newRole({
  ...memberAc.statements,
  project: ['read'],
  asset: ['read'],
})

export const organizationRoles = {
  owner: ownerRole,
  admin: adminRole,
  developer: developerRole,
  viewer: viewerRole,
}
