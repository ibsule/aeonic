export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'ApiError'
  }
}
