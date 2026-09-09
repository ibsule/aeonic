import { type AnySchema, Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import type { Response } from 'express'

const ajv = new Ajv2020({ allErrors: true, strict: true })
// ajv-formats publishes CommonJS with an ESM-shaped declaration. Node exposes the callable export
// as the default value, while TypeScript 6 conservatively models the binding as a module namespace.
const addFormats = addFormatsModule as unknown as FormatsPlugin
addFormats(ajv)

const validators = new WeakMap<object, ValidateFunction>()

export class ResponseContractError extends Error {
  override readonly name = 'ResponseContractError'
}

export function assertResponseMatches(schema: object, body: unknown): void {
  const existingValidator = validators.get(schema)
  const validate = existingValidator ?? ajv.compile(schema as AnySchema)
  if (!existingValidator) {
    validators.set(schema, validate)
  }

  if (!validate(body)) {
    const details = ajv.errorsText(validate.errors, { separator: '; ' })
    throw new ResponseContractError(`Response does not match its contract: ${details}`)
  }
}

export function matchesSchema<T>(schema: object, value: unknown): value is T {
  const existingValidator = validators.get(schema)
  const validate = existingValidator ?? ajv.compile(schema as AnySchema)
  if (!existingValidator) validators.set(schema, validate)
  return validate(value) === true
}

export function sendJson<T>(response: Response, status: number, schema: object, body: T): Response {
  assertResponseMatches(schema, body)
  return response.status(status).json(body)
}
