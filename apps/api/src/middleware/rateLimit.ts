import { Request, Response, NextFunction } from 'express'

interface RateLimitState {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitState>()

// Clean up expired entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, state] of store.entries()) {
    if (now > state.resetAt) store.delete(key)
  }
}, 5 * 60 * 1000)

/**
 * Simple in-memory rate limiter.
 * Uses API key userId when available, falls back to IP address.
 *
 * @param limit   Max requests per window
 * @param windowMs Window duration in milliseconds (default: 60 seconds)
 */
export function rateLimit(limit: number, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Prefer authenticated user ID over raw IP (more reliable, survives proxies)
    const identifier =
      (res.locals.userId as string | undefined) ??
      (req.headers['cf-connecting-ip'] as string) ??
      req.ip ??
      'unknown'

    const now = Date.now()
    const state = store.get(identifier) ?? { count: 0, resetAt: now + windowMs }

    if (now > state.resetAt) {
      state.count = 0
      state.resetAt = now + windowMs
    }

    state.count++
    store.set(identifier, state)

    // Set standard rate limit headers
    res.set({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(Math.max(0, limit - state.count)),
      'X-RateLimit-Reset': String(Math.ceil(state.resetAt / 1000)),
    })

    if (state.count > limit) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((state.resetAt - now) / 1000),
      })
      return
    }

    next()
  }
}