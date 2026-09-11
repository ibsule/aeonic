import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type OrganizationRole,
  type ProjectAction,
  roleAllows,
  roleHasOrganizationWideProjectAccess,
} from '../src/authorization/policy.js'

const actions: readonly ProjectAction[] = [
  'create',
  'read',
  'update',
  'delete',
  'manage_api_keys',
  'read_audit',
  'upload',
]

const expected: Record<OrganizationRole, readonly ProjectAction[]> = {
  owner: actions,
  admin: actions,
  developer: ['read', 'manage_api_keys', 'upload'],
  viewer: ['read'],
}

describe('authorization policy', () => {
  for (const role of Object.keys(expected) as OrganizationRole[]) {
    it(`defines the complete ${role} permission matrix`, () => {
      for (const action of actions) {
        assert.equal(roleAllows(role, action), expected[role].includes(action), action)
      }
      assert.equal(roleHasOrganizationWideProjectAccess(role), role === 'owner' || role === 'admin')
    })
  }
})
