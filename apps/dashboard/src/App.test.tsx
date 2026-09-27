import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const ids = {
  organization: '0199a100-0000-7000-8000-000000000001',
  project: '0199a100-0000-7000-8000-000000000002',
  user: '0199a100-0000-7000-8000-000000000003',
}
const session = {
  session: { id: 'session-1' },
  user: { id: ids.user, email: 'owner@example.com', name: 'Project Owner' },
}
const storage = {
  backend: 'local',
  health: { status: 'available', writable: true, capacity: null },
  usage: {
    usedBytes: 0,
    reservedBytes: 0,
    quotaBytes: 10737418240,
    quotaRemainingBytes: 10737418240,
  },
  objects: { available: 0, staging: 0, failed: 0 },
  uploads: { active: 0, failed: 0, rejected: 0, expired: 0 },
  derivatives: { queued: 0, generating: 0, ready: 0, failed: 0, readyBytes: 0 },
  failures: [],
  checkedAt: new Date().toISOString(),
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function accessibilityViolations() {
  return (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }))
    .violations
}

function mockJourney(options: { setupRequired?: boolean; failJobs?: boolean } = {}) {
  let setupRequired = options.setupRequired ?? false
  let active = !setupRequired
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input)
    if (path === '/api/v1/setup' && (!init?.method || init.method === 'GET'))
      return json({ status: setupRequired ? 'required' : 'complete' })
    if (path === '/api/v1/setup' && init?.method === 'POST') {
      setupRequired = false
      return json(
        { userId: ids.user, organizationId: ids.organization, projectId: ids.project },
        201,
      )
    }
    if (path === '/api/auth/sign-in/email') {
      active = true
      return json(session)
    }
    if (path === '/api/auth/get-session') return json(active ? session : null)
    if (path === '/api/auth/organization/list')
      return json([{ id: ids.organization, name: 'Example Studio', slug: 'example-studio' }])
    if (path.endsWith(`/organizations/${ids.organization}/projects`))
      return json({
        items: [
          {
            id: ids.project,
            organizationId: ids.organization,
            name: 'Media library',
            slug: 'media-library',
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      })
    if (path.includes('/assets?')) return json({ items: [], nextCursor: null })
    if (path.includes('/jobs?'))
      return options.failJobs
        ? json(
            {
              code: 'worker_unavailable',
              detail: 'The job service is unavailable. Check worker health and retry.',
            },
            503,
          )
        : json({ items: [], nextCursor: null })
    if (path.endsWith('/storage')) return json(storage)
    throw new Error(`Unexpected request: ${path}`)
  })
}

afterEach(() => vi.restoreAllMocks())

describe('primary operator journey', () => {
  it('completes first-run setup and reaches upload without command-line API calls', async () => {
    mockJourney({ setupRequired: true })
    const user = userEvent.setup()
    render(<App />)
    expect(
      await screen.findByRole('heading', { name: 'Create your workspace' }),
    ).toBeInTheDocument()
    expect(await accessibilityViolations()).toEqual([])
    await user.type(screen.getByLabelText('Your name'), 'Project Owner')
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'a-strong-development-password')
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))
    expect(await screen.findByRole('heading', { name: 'Media library' })).toBeInTheDocument()
    const assets = screen.getByRole('button', { name: 'Assets' })
    assets.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Assets' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Upload media' }))
    expect(screen.getByRole('dialog', { name: 'Upload media' })).toBeInTheDocument()
    expect(await accessibilityViolations()).toEqual([])
  })

  it('presents an actionable operator failure state', async () => {
    mockJourney({ failJobs: true })
    render(<App />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Check worker health and retry')
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
