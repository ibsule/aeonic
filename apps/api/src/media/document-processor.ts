import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { assertOutputSize, stageMediaInput } from './staged-input.js'
import { runMediaCommand } from './subprocess.js'

export interface DocumentLimits {
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxPages: number
  readonly maxPagePoints: number
  readonly maxTextBytes: number
  readonly timeoutMs: number
}

export interface PdfInspection {
  readonly pages: number
  readonly widthPoints: number
  readonly heightPoints: number
  readonly encrypted: boolean
  readonly pdfVersion: string
}

const officeExtensions: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

function commandOptions(limits: DocumentLimits, signal?: AbortSignal, maxStdoutBytes = 262_144) {
  return {
    timeoutMs: limits.timeoutMs,
    maxStdoutBytes,
    maxStderrBytes: 262_144,
    ...(signal ? { signal } : {}),
  }
}

function field(output: string, name: string): string | null {
  const matched = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(output)
  return matched?.[1]?.trim() ?? null
}

async function inspectPdfPath(
  path: string,
  limits: DocumentLimits,
  signal?: AbortSignal,
): Promise<PdfInspection> {
  const result = await runMediaCommand(
    'pdfinfo',
    ['-isodates', path],
    commandOptions(limits, signal),
  )
  const output = result.stdout.toString('utf8')
  const pages = Number(field(output, 'Pages'))
  const pageSize = /^(\d+(?:\.\d+)?)\s+x\s+(\d+(?:\.\d+)?)\s+pts/i.exec(
    field(output, 'Page size') ?? '',
  )
  const widthPoints = Number(pageSize?.[1])
  const heightPoints = Number(pageSize?.[2])
  const encrypted = /^yes\b/i.test(field(output, 'Encrypted') ?? '')
  const pdfVersion = field(output, 'PDF version') ?? 'unknown'
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > limits.maxPages ||
    !Number.isFinite(widthPoints) ||
    !Number.isFinite(heightPoints) ||
    widthPoints <= 0 ||
    heightPoints <= 0 ||
    widthPoints > limits.maxPagePoints ||
    heightPoints > limits.maxPagePoints ||
    encrypted
  ) {
    throw new RangeError('PDF metadata is invalid, encrypted, or exceeds configured limits.')
  }
  return { pages, widthPoints, heightPoints, encrypted, pdfVersion }
}

export async function inspectPdf(
  source: Readable,
  limits: DocumentLimits,
  signal?: AbortSignal,
): Promise<PdfInspection> {
  const staged = await stageMediaInput(source, 'pdf', limits.maxInputBytes, signal)
  try {
    return await inspectPdfPath(staged.path, limits, signal)
  } finally {
    await staged.cleanup()
  }
}

export async function extractPdfText(
  source: Readable,
  limits: DocumentLimits,
  signal?: AbortSignal,
): Promise<string> {
  const staged = await stageMediaInput(source, 'pdf', limits.maxInputBytes, signal)
  try {
    const inspection = await inspectPdfPath(staged.path, limits, signal)
    const result = await runMediaCommand(
      'pdftotext',
      ['-layout', '-f', '1', '-l', String(inspection.pages), staged.path, '-'],
      commandOptions(limits, signal, limits.maxTextBytes),
    )
    return result.stdout.toString('utf8').replaceAll('\0', '').trim()
  } finally {
    await staged.cleanup()
  }
}

export async function createPdfThumbnail(
  source: Readable,
  page: number,
  maxDimension: number,
  limits: DocumentLimits,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(maxDimension) ||
    maxDimension < 1 ||
    maxDimension > 4096
  ) {
    throw new TypeError('PDF thumbnail options are invalid.')
  }
  const staged = await stageMediaInput(source, 'pdf', limits.maxInputBytes, signal)
  try {
    const inspection = await inspectPdfPath(staged.path, limits, signal)
    if (page > inspection.pages) throw new RangeError('The requested PDF page does not exist.')
    const prefix = join(staged.directory, 'preview')
    await runMediaCommand(
      'pdftoppm',
      [
        '-f',
        String(page),
        '-l',
        String(page),
        '-singlefile',
        '-scale-to',
        String(maxDimension),
        '-png',
        staged.path,
        prefix,
      ],
      commandOptions(limits, signal),
    )
    const output = `${prefix}.png`
    await assertOutputSize(output, limits.maxOutputBytes)
    return readFile(output)
  } finally {
    await staged.cleanup()
  }
}

export async function convertOfficeToPdf(
  source: Readable,
  mimeType: string,
  limits: DocumentLimits,
  signal?: AbortSignal,
): Promise<Buffer> {
  const extension = officeExtensions[mimeType]
  if (!extension) throw new TypeError('Unsupported office document media type.')
  const staged = await stageMediaInput(source, extension, limits.maxInputBytes, signal)
  const outputPath = join(staged.directory, 'input.pdf')
  try {
    const runtimeDirectory = join(staged.directory, 'runtime')
    await mkdir(runtimeDirectory)
    await runMediaCommand(
      'libreoffice',
      [
        `-env:UserInstallation=file://${join(staged.directory, 'profile')}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        staged.directory,
        staged.path,
      ],
      { ...commandOptions(limits, signal), runtimeDirectory },
    )
    await assertOutputSize(outputPath, limits.maxOutputBytes)
    await inspectPdfPath(outputPath, limits, signal)
    return readFile(outputPath)
  } finally {
    await staged.cleanup()
  }
}
