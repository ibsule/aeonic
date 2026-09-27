import { spawn } from 'node:child_process'

export type MediaCommandFailureCode =
  | 'invalid_command'
  | 'command_not_found'
  | 'command_timeout'
  | 'command_aborted'
  | 'command_output_exceeded'
  | 'command_failed'

export class MediaCommandError extends Error {
  override readonly name = 'MediaCommandError'

  constructor(
    readonly code: MediaCommandFailureCode,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message)
  }
}

export interface MediaCommandOptions {
  readonly cwd?: string
  readonly timeoutMs: number
  readonly maxStdoutBytes: number
  readonly maxStderrBytes: number
  readonly signal?: AbortSignal
}

export interface MediaCommandResult {
  readonly stdout: Buffer
  readonly stderr: Buffer
}

function assertOptions(executable: string, args: readonly string[], options: MediaCommandOptions) {
  if (
    executable.trim() === '' ||
    executable.includes('\0') ||
    args.length > 128 ||
    args.some((argument) => argument.includes('\0'))
  ) {
    throw new MediaCommandError('invalid_command', 'The media command is invalid.')
  }
  for (const [name, value] of [
    ['timeoutMs', options.timeoutMs],
    ['maxStdoutBytes', options.maxStdoutBytes],
    ['maxStderrBytes', options.maxStderrBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MediaCommandError('invalid_command', `${name} must be a positive safe integer.`)
    }
  }
}

export async function runMediaCommand(
  executable: string,
  args: readonly string[],
  options: MediaCommandOptions,
): Promise<MediaCommandResult> {
  assertOptions(executable, args, options)
  options.signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let exceeded = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const child = spawn(executable, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    }
    const abort = (): void => {
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    timer.unref()
    options.signal?.addEventListener('abort', abort, { once: true })

    child.once('error', (error) => {
      finish(
        new MediaCommandError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'command_not_found'
            : 'command_failed',
          'The media command could not be started.',
        ),
      )
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxStdoutBytes) {
        exceeded = true
        child.kill('SIGKILL')
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > options.maxStderrBytes) {
        exceeded = true
        child.kill('SIGKILL')
        return
      }
      stderr.push(chunk)
    })
    child.once('close', (exitCode) => {
      if (options.signal?.aborted) {
        finish(new MediaCommandError('command_aborted', 'The media command was cancelled.'))
      } else if (timedOut) {
        finish(new MediaCommandError('command_timeout', 'The media command exceeded its deadline.'))
      } else if (exceeded) {
        finish(
          new MediaCommandError(
            'command_output_exceeded',
            'The media command exceeded its output limit.',
          ),
        )
      } else if (exitCode !== 0) {
        finish(
          new MediaCommandError(
            'command_failed',
            'The media command rejected the input.',
            exitCode,
          ),
        )
      } else {
        finish()
      }
    })
  })
}
