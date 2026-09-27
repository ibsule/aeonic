import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import {
  convertOfficeToPdf,
  createPdfThumbnail,
  extractPdfText,
  inspectPdf,
} from '../src/media/document-processor.js'
import { runMediaCommand } from '../src/media/subprocess.js'

function pdfFixture(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 50 Td (Hello Aeonic) Tj ET\nendstream',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

const limits = {
  maxInputBytes: 1_000_000,
  maxOutputBytes: 2_000_000,
  maxPages: 10,
  maxPagePoints: 2_000,
  maxTextBytes: 100_000,
  timeoutMs: 10_000,
}

describe('bounded PDF processor', () => {
  it('inspects page geometry and extracts bounded text', async () => {
    const fixture = pdfFixture()
    const inspection = await inspectPdf(Readable.from(fixture), limits)
    assert.equal(inspection.pages, 1)
    assert.equal(inspection.widthPoints, 200)
    assert.equal(inspection.heightPoints, 100)
    assert.match(await extractPdfText(Readable.from(fixture), limits), /Hello Aeonic/)
  })

  it('renders a selected page and enforces page limits', async () => {
    const fixture = pdfFixture()
    const thumbnail = await createPdfThumbnail(Readable.from(fixture), 1, 200, limits)
    const metadata = await sharp(thumbnail).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 200)
    await assert.rejects(
      inspectPdf(Readable.from(fixture), { ...limits, maxPagePoints: 100 }),
      /exceeds configured limits/,
    )
    await assert.rejects(
      createPdfThumbnail(Readable.from(fixture), 2, 200, limits),
      /does not exist/,
    )
  })

  it('converts an Office document into a validated PDF preview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeonic-office-fixture-'))
    try {
      const sourcePath = join(directory, 'fixture.fodt')
      await writeFile(
        sourcePath,
        `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
  <office:body><office:text><text:p>Aeonic preview</text:p></office:text></office:body>
</office:document>`,
      )
      await runMediaCommand(
        'libreoffice',
        [
          `-env:UserInstallation=file://${join(directory, 'profile')}`,
          '--headless',
          '--convert-to',
          'docx',
          '--outdir',
          directory,
          sourcePath,
        ],
        {
          timeoutMs: 20_000,
          maxStdoutBytes: 100_000,
          maxStderrBytes: 100_000,
          runtimeDirectory: directory,
        },
      )
      const docx = await readFile(join(directory, 'fixture.docx'))
      const pdf = await convertOfficeToPdf(
        Readable.from(docx),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        limits,
      )
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-')
      assert.equal((await inspectPdf(Readable.from(pdf), limits)).pages, 1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
