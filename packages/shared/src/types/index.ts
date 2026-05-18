import { z } from 'zod'

// ── File ──────────────────────────────────────────────────────────────────────

export const FileSchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  folder: z.string(),
  mime_type: z.string(),
  size: z.number(),
  uploaded_by: z.string().nullable(),
  created_at: z.number(),
})

export type FileRecord = z.infer<typeof FileSchema>

// ── Upload ────────────────────────────────────────────────────────────────────

export const UploadResponseSchema = z.object({
  key: z.string(),
  name: z.string(),
  url: z.string(),
  size: z.number(),
  mime_type: z.string(),
})

export type UploadResponse = z.infer<typeof UploadResponseSchema>

// ── API responses ─────────────────────────────────────────────────────────────

export const ErrorResponseSchema = z.object({
  error: z.string(),
  setup: z.boolean().optional(),
})

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// ── File list pagination ──────────────────────────────────────────────────────

export const FileListQuerySchema = z.object({
  folder: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().optional(),
})

export type FileListQuery = z.infer<typeof FileListQuerySchema>

export const FileListResponseSchema = z.object({
  files: z.array(FileSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  pages: z.number(),
})

export type FileListResponse = z.infer<typeof FileListResponseSchema>