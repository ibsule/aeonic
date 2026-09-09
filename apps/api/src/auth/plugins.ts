import { apiKey } from '@better-auth/api-key'
import type { BetterAuthPlugin } from 'better-auth'
import { organization } from 'better-auth/plugins'
import {
  accessControl,
  adminRole,
  developerRole,
  organizationRoles,
  ownerRole,
  viewerRole,
} from './permissions.js'

export function createAuthPlugins(): BetterAuthPlugin[] {
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
