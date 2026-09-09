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

export interface AuthAuditEvent {
  organizationId: string
  actorType: 'user' | 'system'
  actorId: string | null
  action: string
  targetType: string
  targetId: string
  summary?: Record<string, unknown>
}

export type AuthAuditSink = (event: AuthAuditEvent) => void

export function createAuthPlugins(audit?: AuthAuditSink): [OrganizationPlugin, ApiKeyPlugin] {
  const record = async (event: AuthAuditEvent): Promise<void> => audit?.(event)
  return [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      creatorRole: 'owner',
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: false,
      organizationHooks: {
        afterUpdateOrganization: async ({ organization, user }) => {
          if (!organization) return
          await record({
            organizationId: organization.id,
            actorType: 'user',
            actorId: user.id,
            action: 'organization.updated',
            targetType: 'organization',
            targetId: organization.id,
          })
        },
        afterAddMember: async ({ member, user, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'system',
            actorId: null,
            action: 'organization.member_added',
            targetType: 'user',
            targetId: member.userId,
            summary: { email: user.email, role: member.role },
          }),
        afterRemoveMember: async ({ member, user, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'system',
            actorId: null,
            action: 'organization.member_removed',
            targetType: 'user',
            targetId: member.userId,
            summary: { email: user.email, role: member.role },
          }),
        afterUpdateMemberRole: async ({ member, previousRole, user, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'system',
            actorId: null,
            action: 'organization.member_role_updated',
            targetType: 'user',
            targetId: member.userId,
            summary: { email: user.email, previousRole, role: member.role },
          }),
        afterCreateInvitation: async ({ invitation, inviter, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'user',
            actorId: inviter.id,
            action: 'organization.invitation_created',
            targetType: 'invitation',
            targetId: invitation.id,
            summary: { email: invitation.email, role: invitation.role },
          }),
        afterAcceptInvitation: async ({ invitation, user, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'user',
            actorId: user.id,
            action: 'organization.invitation_accepted',
            targetType: 'invitation',
            targetId: invitation.id,
          }),
        afterRejectInvitation: async ({ invitation, user, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'user',
            actorId: user.id,
            action: 'organization.invitation_rejected',
            targetType: 'invitation',
            targetId: invitation.id,
          }),
        afterCancelInvitation: async ({ invitation, cancelledBy, organization }) =>
          record({
            organizationId: organization.id,
            actorType: 'user',
            actorId: cancelledBy.id,
            action: 'organization.invitation_cancelled',
            targetType: 'invitation',
            targetId: invitation.id,
          }),
      },
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
