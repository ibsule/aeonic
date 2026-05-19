import { Request, Response, NextFunction } from 'express'
import { auth } from 'shared/auth'


export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const apiKey =
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ??
    (req.query.api_key as string | undefined)

  if (!apiKey) {
    res.status(401).json({ error: 'API key required. Pass it as Authorization: Bearer <key> or ?api_key=<key>' })
    return
  }

  try {
    const result = await auth.api.verifyApiKey({ body: { key: apiKey } })
    if (!result.valid) {
      res.status(401).json({ error: 'Invalid or revoked API key' })
      return
    }
    res.locals.userId = result.key?.referenceId
    next()
  } catch {
    res.status(401).json({ error: 'Could not verify API key' })
  }
}