import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const outputDirectory = resolve(process.cwd(), 'dist')

await rm(outputDirectory, { force: true, recursive: true })
