export interface ServiceState {
  isReady(): boolean
  markReady(): void
  markStopping(): void
}

export function createServiceState(initiallyReady = false): ServiceState {
  let ready = initiallyReady

  return {
    isReady: () => ready,
    markReady: () => {
      ready = true
    },
    markStopping: () => {
      ready = false
    },
  }
}
