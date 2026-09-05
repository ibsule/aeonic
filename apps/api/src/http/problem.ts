import type { ProblemDetails } from '@aeonic/contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'

interface ProblemOptions {
  status: number
  title: string
  code: string
  detail?: string
  type?: string
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProblemOptions,
): FastifyReply {
  const problem: ProblemDetails = {
    type: options.type ?? 'about:blank',
    title: options.title,
    status: options.status,
    code: options.code,
    requestId: request.id,
    instance: request.url,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  }

  return reply.code(options.status).type('application/problem+json').send(problem)
}
