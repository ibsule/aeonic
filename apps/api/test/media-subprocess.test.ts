import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MediaCommandError, runMediaCommand } from '../src/media/subprocess.js'

const limits = { timeoutMs: 1_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024 }

describe('bounded media subprocesses', () => {
  it('passes enumerated arguments without shell interpretation', async () => {
    const result = await runMediaCommand(
      '/usr/bin/printf',
      ['%s', '$(echo unsafe);`whoami`'],
      limits,
    )
    assert.equal(result.stdout.toString(), '$(echo unsafe);`whoami`')
  })

  it('enforces output limits and deadlines', async () => {
    await assert.rejects(
      runMediaCommand('/usr/bin/yes', ['x'], limits),
      (error: unknown) =>
        error instanceof MediaCommandError && error.code === 'command_output_exceeded',
    )
    await assert.rejects(
      runMediaCommand('/usr/bin/sleep', ['10'], {
        ...limits,
        timeoutMs: 20,
      }),
      (error: unknown) => error instanceof MediaCommandError && error.code === 'command_timeout',
    )
  })

  it('honors cancellation and missing executables without leaking platform errors', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await assert.rejects(
      runMediaCommand(process.execPath, ['-e', ''], { ...limits, signal: controller.signal }),
      /cancelled/,
    )
    await assert.rejects(
      runMediaCommand('/aeonic/missing-media-tool', [], limits),
      (error: unknown) => error instanceof MediaCommandError && error.code === 'command_not_found',
    )
  })
})
