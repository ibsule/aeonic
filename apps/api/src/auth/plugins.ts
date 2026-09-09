import { apiKey } from '@better-auth/api-key'
import { organization } from 'better-auth/plugins'
import {
  accessControl,
  adminRole,
  developerRole,
  organizationRoles,
  ownerRole,
  viewerRole,
} from './permissions.js'

type OrganizationPlugin = ReturnType<typeof organization>
type ApiKeyPlugin = ReturnType<typeof apiKey>

export function createAuthPlugins(): [OrganizationPlugin, ApiKeyPlugin] {
  return [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      creatorRole: 'owner',
      allowUserToCreateOrganization: false,
      cancelPendingInvitationsOnReInvite: true,
    }),
    apiKey({
      references: 'organization',
      enableSessionForAPIKeys: false,
      enableMetadata: true,
      keyExpiration: {
        minExpiresIn: 1 / 24,
        maxExpiresIn: 365,
      },
      permissions: {
        defaultPermissions: {
          project: ['read'],
          asset: ['read'],
        },
      },
    }),
  ]
}

export { accessControl, adminRole, developerRole, ownerRole, viewerRole }
