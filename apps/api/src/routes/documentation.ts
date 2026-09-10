import { apiReference } from '@scalar/express-api-reference'
import { Router } from 'express'
import type { AppConfig } from '../config.js'
import { createOpenApiDocument } from '../openapi/document.js'

const scalarCdn = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0'

export function createDocumentationRouter(config: AppConfig): Router {
  const router = Router()
  const document = createOpenApiDocument(config)

  router.get('/openapi.json', (_request, response) => response.json(document))
  router.use(
    '/docs',
    apiReference({
      url: '/openapi.json',
      pageTitle: 'Aeonic API Reference',
      theme: 'default',
      layout: 'modern',
      hideClientButton: true,
      cdn: scalarCdn,
    }),
  )

  return router
}
