import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const ids = {
  organization: '0199a100-0000-7000-8000-000000000001',
  project: '0199a100-0000-7000-8000-000000000002',
  user: '0199a100-0000-7000-8000-000000000003',
  asset: '0199a100-0000-7000-8000-000000000004',
  version: '0199a100-0000-7000-8000-000000000005',
  run: '0199a100-0000-7000-8000-000000000006',
  plan: '0199a100-0000-7000-8000-000000000007',
  approval: '0199a100-0000-7000-8000-000000000008',
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
  let approvalState: 'pending' | 'approved' | 'consumed' = 'pending'
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
    if (path.endsWith('/semantic/settings'))
      return json({
        deploymentEnabled: false,
        providerConfigured: false,
        enabled: false,
        allowPrivateAssets: false,
        monthlyBudgetMicroUsd: 0,
        monthlySpendMicroUsd: 0,
        maxAssetsPerRun: 100,
        concurrency: 1,
        provider: null,
        visionModel: null,
        embeddingModel: null,
        dimensions: null,
        activeIndex: null,
      })
    if (path.endsWith('/agent-approvals') && (!init?.method || init.method === 'GET'))
      return json({
        items:
          approvalState === 'consumed'
            ? []
            : [
                {
                  approval: {
                    id: ids.approval,
                    planId: ids.plan,
                    planHash: 'a'.repeat(64),
                    state: approvalState,
                    requestedBy: ids.user,
                    decidedBy: approvalState === 'approved' ? ids.user : null,
                    decisionReason: null,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    createdAt: new Date().toISOString(),
                    decidedAt: approvalState === 'approved' ? new Date().toISOString() : null,
                    consumedAt: null,
                  },
                  plan: {
                    id: ids.plan,
                    runId: ids.run,
                    organizationId: ids.organization,
                    projectId: ids.project,
                    hash: 'a'.repeat(64),
                    summary: 'Delete one reviewed duplicate',
                    riskClass: 'destructive',
                    reversibility: 'irreversible',
                    requiredRole: 'owner',
                    calls: [
                      {
                        id: 'step_1',
                        tool: 'assets.delete',
                        arguments: { assetId: ids.asset },
                        expectedEffect: 'Delete the reviewed duplicate.',
                        targetIds: [ids.asset],
                      },
                    ],
                    targets: [
                      {
                        assetId: ids.asset,
                        assetVersionId: ids.version,
                        assetVersion: 1,
                        assetUpdatedAt: new Date().toISOString(),
                      },
                    ],
                    budget: {
                      maxSteps: 1,
                      maxWallTimeMs: 60000,
                      maxTokens: 1000,
                      maxCostMicroUsd: 1000,
                      maxAssets: 1,
                      maxOutputBytes: 0,
                      maxRetries: 1,
                    },
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    createdAt: new Date().toISOString(),
                  },
                  run: {
                    id: ids.run,
                    organizationId: ids.organization,
                    projectId: ids.project,
                    state: 'awaiting_approval',
                    request: 'Remove the exact duplicate after review.',
                    provider: null,
                    model: null,
                    budget: {
                      maxSteps: 1,
                      maxWallTimeMs: 60000,
                      maxTokens: 1000,
                      maxCostMicroUsd: 1000,
                      maxAssets: 1,
                      maxOutputBytes: 0,
                      maxRetries: 1,
                    },
                    stepsUsed: 0,
                    tokensUsed: 0,
                    costMicroUsd: 0,
                    createdBy: ids.user,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    completedAt: null,
                    cancelledAt: null,
                  },
                },
              ],
      })
    if (path.endsWith(`/agent-approvals/${ids.approval}/decision`)) {
      approvalState = 'approved'
      return json({ state: approvalState })
    }
    if (path.endsWith(`/agent-approvals/${ids.approval}/execute`)) {
      approvalState = 'consumed'
      return json({ state: 'executing' }, 202)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

  it('keeps optional AI controls explicit and accessible', async () => {
    mockJourney()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Media library' })
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0] as HTMLElement)
    expect(await screen.findByText('Semantic search off')).toBeInTheDocument()
    expect(screen.getByLabelText(/Allow private assets/)).not.toBeChecked()
    expect(screen.getByRole('button', { name: /Build candidate index/ })).toBeDisabled()
    expect(await accessibilityViolations()).toEqual([])
  })

  it('moves focus into and back out of the mobile navigation', async () => {
    mockJourney()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Media library' })

    const openNavigation = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(openNavigation)
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus()
    expect(openNavigation).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{Escape}')
    expect(openNavigation).toHaveFocus()
    expect(openNavigation).toHaveAttribute('aria-expanded', 'false')
  })

  it('requires exact-target review before approving and queueing an agent plan', async () => {
    mockJourney()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Media library' })
    await user.click(screen.getByRole('button', { name: 'Approvals' }))

    expect(await screen.findByText('Delete one reviewed duplicate')).toBeInTheDocument()
    const approve = screen.getByRole('button', { name: /Approve exact plan/ })
    expect(approve).toBeDisabled()
    await user.click(screen.getByLabelText(/I reviewed the exact targets/))
    expect(approve).toBeEnabled()
    await user.click(approve)
    const execute = await screen.findByRole('button', { name: /Queue approved workflow/ })
    await user.click(execute)
    expect(await screen.findByText('No approvals waiting')).toBeInTheDocument()
    expect(await accessibilityViolations()).toEqual([])
  })
})
