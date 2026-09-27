export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError'
}

export class CircuitBreaker {
  #consecutiveFailures = 0
  #openUntil = 0

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
      throw new TypeError('The circuit-breaker failure threshold must be a positive integer.')
    }
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) {
      throw new TypeError('The circuit-breaker cooldown must be a positive integer.')
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const now = this.now()
    if (this.#openUntil > now) {
      throw new CircuitOpenError('The external dependency circuit is temporarily open.')
    }
    try {
      const result = await operation()
      this.#consecutiveFailures = 0
      this.#openUntil = 0
      return result
    } catch (error) {
      this.#consecutiveFailures += 1
      if (this.#consecutiveFailures >= this.failureThreshold) {
        this.#openUntil = now + this.cooldownMs
      }
      throw error
    }
  }

  get state(): 'closed' | 'open' {
    return this.#openUntil > this.now() ? 'open' : 'closed'
  }
}
