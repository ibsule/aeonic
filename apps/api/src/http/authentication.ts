import { fromNodeHeaders } from 'better-auth/node'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthService } from '../auth/auth.js'
import { sendProblem } from './problem.js'

export interface UserPrincipal {
  type: 'user'
  userId: string
  sessionId: string
}

declare global {
  namespace Express {
    interface Request {
      principal?: UserPrincipal
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
  if (!request.principal) throw new Error('Authenticated route is missing a principal')
  return request.principal
}
