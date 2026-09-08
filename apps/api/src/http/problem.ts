import { problemDetailsSchema, type ProblemDetails } from '@aeonic/contracts'
import type { Request, Response } from 'express'
import { sendJson } from './response.js'

interface ProblemOptions {
  status: number
  title: string
  code: string
  detail?: string
  type?: string
}

export function sendProblem(
  request: Request,
  response: Response,
  options: ProblemOptions,
): Response {
  const requestId = String(request.id)
  const problem: ProblemDetails = {
    type: options.type ?? 'about:blank',
    title: options.title,
    status: options.status,
    code: options.code,
    requestId,
    instance: request.originalUrl,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  }

  response.type('application/problem+json')
  return sendJson(response, options.status, problemDetailsSchema, problem)
}
