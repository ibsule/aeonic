import { fromNodeHeaders } from 'better-auth/node'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthService } from '../auth/auth.js'
import { sendProblem } from './problem.js'

export interface UserPrincipal {
  type: 'user'
  userId: string
  sessionId: string
}

export interface ApiKeyPrincipal {
  type: 'api_key'
  keyId: string
  organizationId: string
  projectId: string
}

export type Principal = UserPrincipal | ApiKeyPrincipal

declare global {
  namespace Express {
    interface Request {
      principal?: Principal
    }
  }
}

export function requireUser(auth: AuthService): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const authSession = await auth.getSession(fromNodeHeaders(request.headers))
      if (!authSession) {
        sendProblem(request, response, {
          status: 401,
          title: 'Authentication required',
          code: 'authentication_required',
          detail: 'Sign in to access this resource.',
        })
        return
      }

      request.principal = {
        type: 'user',
        userId: authSession.user.id,
        sessionId: authSession.session.id,
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export function getUserPrincipal(request: Request): UserPrincipal {
  if (request.principal?.type !== 'user') {
    throw new Error('User-authenticated route is missing a user principal')
  }
  return request.principal
}

function parameter(request: Request, name: string): string {
  const value = request.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function hasPermission(
  permissions: Record<string, string[]>,
  resource: string,
  action: string,
): boolean {
  return permissions[resource]?.includes(action) === true
}

export function requireProjectActor(
  auth: AuthService,
  permission: { resource: string; action: string },
): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const suppliedKey = request.get('x-api-key')
      if (suppliedKey !== undefined) {
        const verified = await auth.verifyApiKey(suppliedKey)
        if (
          !verified ||
          verified.organizationId !== parameter(request, 'organizationId') ||
          verified.projectId !== parameter(request, 'projectId') ||
          !hasPermission(verified.permissions, permission.resource, permission.action)
        ) {
          sendProblem(request, response, {
            status: 403,
            title: 'Access denied',
            code: 'access_denied',
            detail: 'The API key cannot perform this action for this project.',
          })
          return
        }
        request.principal = {
          type: 'api_key',
          keyId: verified.id,
          organizationId: verified.organizationId,
          projectId: verified.projectId,
        }
        next()
        return
      }

      await requireUser(auth)(request, response, next)
    } catch (error) {
      next(error)
    }
  }
}
