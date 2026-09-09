import {
  setupRequestSchema,
  type SetupRequest,
  setupResultSchema,
  setupStatusSchema,
} from '@aeonic/contracts'
import { type Request, type Response, Router } from 'express'
import { sendProblem } from '../http/problem.js'
import { matchesSchema, sendJson } from '../http/response.js'
import { SetupAlreadyCompleteError, type SetupService } from '../setup/service.js'

export function createSetupRouter(setup: SetupService): Router {
  const router = Router()

  router.get('/', (_request: Request, response: Response) =>
    sendJson(response, 200, setupStatusSchema, setup.status()),
  )

  router.post('/', async (request: Request, response: Response) => {
    if (!matchesSchema<SetupRequest>(setupRequestSchema, request.body)) {
      return sendProblem(request, response, {
        status: 400,
        title: 'Invalid setup request',
        code: 'invalid_request',
        detail: 'The setup request does not match the required contract.',
      })
    }

    try {
      const result = await setup.initialize(request.body, String(request.id))
      return sendJson(response, 201, setupResultSchema, result)
    } catch (error) {
      if (error instanceof SetupAlreadyCompleteError) {
        return sendProblem(request, response, {
          status: 409,
          title: 'Setup already complete',
          code: 'setup_already_complete',
          detail: 'The initial owner and organization have already been established.',
        })
      }
      throw error
    }
  })

  return router
}
