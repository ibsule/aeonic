import type {
  ApiKey,
  Asset,
  AuditEvent,
  CreateDerivativeRequest,
  Job,
  Project,
  ProjectStorageOverview,
  SemanticSearchResponse,
  SemanticSearchSettings,
  SetupRequest,
  TransformPreset,
} from '@aeonic/contracts'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  CloudUpload,
  EyeOff,
  Files,
  Gauge,
  History,
  KeyRound,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { api, type Session } from './api'

type Page = 'overview' | 'assets' | 'presets' | 'jobs' | 'keys' | 'usage' | 'audit' | 'settings'
type Scope = { organizationId: string; projectId: string }
const msg = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'
const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
function bytes(value: number) {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value
  let index = -1
  do {
    size /= 1024
    index += 1
  } while (size >= 1024 && index < units.length - 1)
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`
}
function ago(value: string) {
  const delta = Date.now() - new Date(value).getTime()
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

function Notice({ children, retry }: { children: ReactNode; retry?: () => void }) {
  return (
    <div className="notice error-notice" role="alert">
      <AlertCircle aria-hidden="true" size={18} />
      <div>
        <strong>We couldn’t complete that action.</strong>
        <p>{children}</p>
      </div>
      {retry ? (
        <button type="button" onClick={retry}>
          <RefreshCw size={15} /> Retry
        </button>
      ) : null}
    </div>
  )
}
function Loading({ label = 'Loading workspace' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" />
      {label}
    </div>
  )
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass the form control as a nested child.
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}
function Empty({ icon, title, copy }: { icon: ReactNode; title: string; copy: string }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      <p>{copy}</p>
    </div>
  )
}
function useDialogKeyboard(close: () => void) {
  const ref = useRef<HTMLElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button, a[href], input, select, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((element) => !element.hasAttribute('disabled'))
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])
  return ref
}
function Header({
  eyebrow,
  title,
  intro,
  action,
}: {
  eyebrow: string
  title: string
  intro: string
  action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{intro}</p>
      </div>
      {action}
    </header>
  )
}

function AuthFrame({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string
  title: string
  intro: string
  children: ReactNode
}) {
  return (
    <main className="auth-layout">
      <section className="auth-brand">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>Aeonic</span>
        </div>
        <div>
          <p className="eyebrow">Private media infrastructure</p>
          <h1>
            Own the library.
            <br />
            Shape every delivery.
          </h1>
          <p>
            A focused workspace for originals, transformations, and dependable media operations.
          </p>
        </div>
        <small>Self-hosted · Open source · Built for durable workflows</small>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
          <p className="auth-intro">{intro}</p>
          {children}
        </div>
      </section>
    </main>
  )
}

function Setup({ done }: { done: (session: Session, scope: Scope) => void }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const organizationName = String(data.get('organizationName'))
    const projectName = String(data.get('projectName'))
    const input: SetupRequest = {
      name: String(data.get('name')),
      email: String(data.get('email')),
      password: String(data.get('password')),
      organizationName,
      organizationSlug: slugify(organizationName),
      projectName,
      projectSlug: slugify(projectName),
    }
    try {
      const result = await api.setup(input)
      await api.signIn(input.email, input.password)
      const session = await api.session()
      if (!session) throw new Error('Setup succeeded, but the session could not be started.')
      done(session, result)
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <AuthFrame
      eyebrow="First-run setup"
      title="Create your workspace"
      intro="This establishes the only initial owner, organization, and first project."
    >
      {error ? <Notice>{error}</Notice> : null}
      <form className="form-stack" onSubmit={submit}>
        <div className="field-pair">
          <Field label="Your name">
            <input name="name" required autoComplete="name" />
          </Field>
          <Field label="Email">
            <input name="email" type="email" required autoComplete="email" />
          </Field>
        </div>
        <Field label="Password" hint="Use at least 12 characters.">
          <input
            name="password"
            type="password"
            minLength={12}
            required
            autoComplete="new-password"
          />
        </Field>
        <div className="field-pair">
          <Field label="Organization">
            <input name="organizationName" required defaultValue="My studio" />
          </Field>
          <Field label="First project">
            <input name="projectName" required defaultValue="Media library" />
          </Field>
        </div>
        <button className="primary-button wide" disabled={pending} type="submit">
          {pending ? <LoaderCircle className="spin" /> : <ArrowUpRight />}Create workspace
        </button>
      </form>
    </AuthFrame>
  )
}

function SignIn({ done }: { done: (session: Session) => void }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      await api.signIn(String(data.get('email')), String(data.get('password')))
      const session = await api.session()
      if (!session) throw new Error('The session could not be started.')
      done(session)
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <AuthFrame
      eyebrow="Welcome back"
      title="Sign in to Aeonic"
      intro="Use the owner or team credentials configured for this installation."
    >
      {error ? <Notice>{error}</Notice> : null}
      <form className="form-stack" onSubmit={submit}>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" />
        </Field>
        <button className="primary-button wide" disabled={pending} type="submit">
          {pending ? <LoaderCircle className="spin" /> : <LockKeyhole />}Sign in
        </button>
      </form>
    </AuthFrame>
  )
}

export function App() {
  const [state, setState] = useState<'loading' | 'setup' | 'signin' | 'workspace'>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [scope, setScope] = useState<Scope | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    Promise.all([api.setupStatus(), api.session()])
      .then(([setup, active]) => {
        if (setup.status === 'required') setState('setup')
        else if (!active) setState('signin')
        else {
          setSession(active)
          setState('workspace')
        }
      })
      .catch((caught) => setError(msg(caught)))
  }, [])
  if (error)
    return (
      <main className="fatal-state">
        <Notice retry={() => location.reload()}>{error}</Notice>
      </main>
    )
  if (state === 'loading') return <Loading label="Connecting to Aeonic" />
  if (state === 'setup')
    return (
      <Setup
        done={(next, result) => {
          setSession(next)
          setScope(result)
          setState('workspace')
        }}
      />
    )
  if (state === 'signin')
    return (
      <SignIn
        done={(next) => {
          setSession(next)
          setState('workspace')
        }}
      />
    )
  return session ? (
    <Workspace
      session={session}
      initialScope={scope}
      signedOut={() => {
        setSession(null)
        setState('signin')
      }}
    />
  ) : null
}

interface NavItem {
  page: Page
  label: string
  icon: LucideIcon
}

const workspaceNav: NavItem[] = [
  { page: 'overview' as const, label: 'Overview', icon: LayoutGrid },
  { page: 'assets' as const, label: 'Assets', icon: Files },
  { page: 'presets' as const, label: 'Presets', icon: SlidersHorizontal },
  { page: 'jobs' as const, label: 'Jobs', icon: Activity },
]
const manageNav: NavItem[] = [
  { page: 'keys' as const, label: 'API keys', icon: KeyRound },
  { page: 'usage' as const, label: 'Usage', icon: Gauge },
  { page: 'audit' as const, label: 'Audit history', icon: History },
  { page: 'settings' as const, label: 'Settings', icon: Settings2 },
]
const pageTitles: Record<Page, string> = {
  overview: 'Overview',
  assets: 'Media archive',
  presets: 'Transform presets',
  jobs: 'Processing queue',
  keys: 'API access',
  usage: 'Storage system',
  audit: 'Audit history',
  settings: 'Project settings',
}
function Nav({
  label,
  items,
  page,
  go,
  secondary,
}: {
  label: string
  items: NavItem[]
  page: Page
  go: (value: Page) => void
  secondary?: boolean
}) {
  return (
    <nav aria-label={label}>
      <p className={secondary ? 'nav-label secondary-label' : 'nav-label'}>{label}</p>
      <ul className="nav-list">
        {items.map(({ page: value, label: text, icon: Icon }, index) => (
          <li key={value}>
            <button
              type="button"
              className={page === value ? 'nav-item is-selected' : 'nav-item'}
              aria-current={page === value ? 'page' : undefined}
              onClick={() => go(value)}
            >
              <span className="nav-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <Icon size={18} />
              <span>{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function Workspace({
  session,
  initialScope,
  signedOut,
}: {
  session: Session
  initialScope: Scope | null
  signedOut: () => void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [scope, setScope] = useState<Scope | null>(initialScope)
  const [page, setPage] = useState<Page>('overview')
  const [upload, setUpload] = useState(false)
  const [newProject, setNewProject] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const mobileMenuRef = useRef<HTMLButtonElement>(null)
  const mobileCloseRef = useRef<HTMLButtonElement>(null)
  const mobileWasOpen = useRef(false)
  const boot = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const organizations = await api.organizations()
      const organizationId = scope?.organizationId ?? organizations[0]?.id
      if (!organizationId) throw new Error('No organization is available for this account.')
      const result = await api.projects(organizationId)
      setProjects(result.items)
      const projectId = scope?.projectId ?? result.items[0]?.id
      if (!projectId) throw new Error('No project is available.')
      setScope({ organizationId, projectId })
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setLoading(false)
    }
  }, [scope?.organizationId, scope?.projectId])
  useEffect(() => {
    void boot()
  }, [boot])
  useEffect(() => {
    if (mobile) {
      mobileWasOpen.current = true
      mobileCloseRef.current?.focus()
      return
    }
    if (mobileWasOpen.current) {
      mobileWasOpen.current = false
      mobileMenuRef.current?.focus()
    }
  }, [mobile])
  if (loading) return <Loading />
  const project = projects.find((item) => item.id === scope?.projectId)
  if (error || !scope || !project)
    return (
      <main className="fatal-state">
        <Notice retry={() => void boot()}>{error || 'The selected project is unavailable.'}</Notice>
      </main>
    )
  const go = (value: Page) => {
    setPage(value)
    setMobile(false)
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside
        id="primary-navigation"
        className={mobile ? 'sidebar mobile-open' : 'sidebar'}
        aria-label="Primary navigation"
        onKeyDown={(event) => {
          if (event.key === 'Escape') setMobile(false)
        }}
      >
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>Aeonic</span>
          <button
            ref={mobileCloseRef}
            className="mobile-close"
            type="button"
            onClick={() => setMobile(false)}
            aria-label="Close navigation"
          >
            <X />
          </button>
        </div>
        <Nav label="Workspace" items={workspaceNav} page={page} go={go} />
        <Nav label="Manage" items={manageNav} page={page} go={go} secondary />
        <div className="sidebar-footer">
          <a className="support-link" href="/docs">
            <CircleHelp size={17} />
            Documentation
          </a>
          <button
            className="profile"
            type="button"
            onClick={async () => {
              await api.signOut()
              signedOut()
            }}
          >
            <span className="avatar">
              {session.user.name
                .split(/\s+/)
                .map((word) => word[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span className="profile-copy">
              <strong>{session.user.name}</strong>
              <small>{session.user.email}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            ref={mobileMenuRef}
            className="mobile-menu"
            type="button"
            onClick={() => setMobile(true)}
            aria-label="Open navigation"
            aria-controls="primary-navigation"
            aria-expanded={mobile}
          >
            <Menu />
          </button>
          <div className="topbar-context">
            <label className="project-switcher">
              <span className="project-dot" />
              <span className="sr-only">Current project</span>
              <select
                value={scope.projectId}
                onChange={(event) => setScope({ ...scope, projectId: event.target.value })}
              >
                {projects.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </label>
            <span className="topbar-divider" aria-hidden="true" />
            <span className="topbar-page">{pageTitles[page]}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => setNewProject(true)}
              aria-label="Create project"
            >
              <Plus size={18} />
            </button>
            <button
              className="primary-button compact"
              type="button"
              onClick={() => setUpload(true)}
            >
              <Upload size={16} />
              Upload
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <Content page={page} scope={scope} project={project} openUpload={() => setUpload(true)} />
        </main>
      </div>
      {upload ? (
        <UploadModal
          scope={scope}
          close={() => setUpload(false)}
          done={() => {
            setUpload(false)
            setPage('assets')
          }}
        />
      ) : null}
      {newProject ? (
        <ProjectModal
          organizationId={scope.organizationId}
          close={() => setNewProject(false)}
          done={(created) => {
            setProjects((items) => [...items, created])
            setScope({ organizationId: scope.organizationId, projectId: created.id })
            setNewProject(false)
          }}
        />
      ) : null}
    </div>
  )
}

function Content({
  page,
  scope,
  project,
  openUpload,
}: {
  page: Page
  scope: Scope
  project: Project
  openUpload: () => void
}) {
  if (page === 'overview')
    return <Overview scope={scope} project={project} openUpload={openUpload} />
  if (page === 'assets') return <Assets scope={scope} openUpload={openUpload} />
  if (page === 'presets') return <Presets scope={scope} />
  if (page === 'jobs') return <Jobs scope={scope} />
  if (page === 'keys') return <Keys scope={scope} />
  if (page === 'usage') return <Usage scope={scope} />
  if (page === 'audit') return <Audit scope={scope} />
  return <Settings scope={scope} project={project} />
}
function AssetRows({
  items,
  select,
  scope,
  variant = 'compact',
}: {
  items: Asset[]
  select?: (item: Asset) => void
  scope?: Scope
  variant?: 'compact' | 'archive' | 'explore'
}) {
  return items.length ? (
    <div className={`asset-list ${variant}`}>
      {items.map((item, index) => {
        const preview =
          scope && item.mediaKind === 'image' && item.state === 'ready'
            ? `/api/v1/organizations/${scope.organizationId}/projects/${scope.projectId}/assets/${item.publicId}/versions/${item.currentVersion}/original`
            : null
        return (
          <button className="asset-row" type="button" key={item.id} onClick={() => select?.(item)}>
            <span className={`asset-preview ${item.mediaKind}`}>
              {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
              <span>
                {item.version?.mimeType?.split('/').at(-1)?.toUpperCase() ?? item.mediaKind}
              </span>
            </span>
            <span className="asset-index" aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="asset-info">
              <strong>{item.name}</strong>
              <small>
                {item.folder || 'Unfiled'} ·{' '}
                {item.version?.sizeBytes ? bytes(item.version.sizeBytes) : item.state}
              </small>
            </span>
            <span className={`privacy ${item.visibility}`}>{item.visibility}</span>
            <time dateTime={item.createdAt}>{ago(item.createdAt)}</time>
          </button>
        )
      })}
    </div>
  ) : (
    <Empty
      icon={<Files />}
      title="No media yet"
      copy="Upload an image, video, or document to begin."
    />
  )
}
function JobRows({ items }: { items: Job[] }) {
  return items.length ? (
    <ol className="queue-list">
      {items.map((item, index) => (
        <li key={item.id}>
          <span className="queue-number">{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{item.type.replaceAll('.', ' / ')}</strong>
            <small>
              {item.errorMessage ?? `${item.state} · attempt ${item.attempts}/${item.maxAttempts}`}
            </small>
            {item.state === 'running' ? (
              <div
                className="progress"
                role="progressbar"
                aria-label={`${item.type} progress`}
                aria-valuenow={item.progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${item.progress}%` }} />
              </div>
            ) : null}
          </div>
          <b className={`state-text ${item.state}`}>
            {item.state === 'running' ? `${item.progress}%` : item.state}
          </b>
        </li>
      ))}
    </ol>
  ) : (
    <Empty icon={<Check />} title="Queue clear" copy="New processing work will appear here." />
  )
}

function useSummary(scope: Scope) {
  const [data, setData] = useState<{
    assets: Asset[]
    jobs: Job[]
    storage: ProjectStorageOverview
  } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setError('')
    try {
      const [assets, jobs, storage] = await Promise.all([
        api.assets(scope.organizationId, scope.projectId),
        api.jobs(scope.organizationId, scope.projectId),
        api.storage(scope.organizationId, scope.projectId),
      ])
      setData({ assets: assets.items, jobs: jobs.items, storage })
    } catch (caught) {
      setError(msg(caught))
    }
  }, [scope])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, load }
}
function Metric({
  icon,
  tone,
  label,
  value,
  detail,
  progress,
}: {
  icon: ReactNode
  tone: string
  label: string
  value: string
  detail: string
  progress?: number
}) {
  return (
    <article className={tone === 'dark' ? 'metric-card featured-card' : 'metric-card'}>
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      {progress !== undefined ? (
        <div
          className="storage-meter"
          role="progressbar"
          aria-label="Storage used"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </article>
  )
}
function Overview({
  scope,
  project,
  openUpload,
}: {
  scope: Scope
  project: Project
  openUpload: () => void
}) {
  const { data, error, load } = useSummary(scope)
  if (error)
    return (
      <>
        <Header
          eyebrow="Workspace"
          title={project.name}
          intro="A live view of the media pipeline."
        />
        <Notice retry={() => void load()}>{error}</Notice>
      </>
    )
  if (!data) return <Loading label="Loading project overview" />
  const active = data.jobs.filter((job) => job.state === 'queued' || job.state === 'running')
  const failed = data.jobs.filter((job) => job.state === 'failed')
  const percent = Math.min(
    100,
    Math.round((data.storage.usage.usedBytes / data.storage.usage.quotaBytes) * 100),
  )
  return (
    <>
      <Header
        eyebrow="Workspace overview"
        title={project.name}
        intro="Storage, recent media, and processing health in one place."
        action={
          <button className="primary-button" type="button" onClick={openUpload}>
            <Upload size={18} />
            Upload media
          </button>
        }
      />
      {failed.length ? (
        <div className="notice warning-notice">
          <AlertCircle />
          <div>
            <strong>
              {failed.length} job{failed.length === 1 ? '' : 's'} need attention
            </strong>
            <p>{failed[0]?.errorMessage}</p>
          </div>
        </div>
      ) : null}
      <section className="metrics-grid" aria-label="Workspace statistics">
        <Metric
          icon={<Files />}
          tone="amber"
          label="Total assets"
          value={String(data.assets.length)}
          detail={`${data.assets.filter((item) => item.state === 'ready').length} ready`}
        />
        <Metric
          icon={<Gauge />}
          tone="blue"
          label="Storage used"
          value={bytes(data.storage.usage.usedBytes)}
          detail={`${percent}% of ${bytes(data.storage.usage.quotaBytes)}`}
          progress={percent}
        />
        <Metric
          icon={<Activity />}
          tone="mint"
          label="Active jobs"
          value={String(active.length)}
          detail={`${data.jobs.filter((item) => item.state === 'succeeded').length} completed recently`}
        />
        <Metric
          icon={<Check />}
          tone="dark"
          label="Storage health"
          value={data.storage.health.status}
          detail={`${data.storage.backend} backend`}
        />
      </section>
      <div className="content-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Library</p>
              <h2>Recent media</h2>
            </div>
          </div>
          <AssetRows items={data.assets.slice(0, 5)} scope={scope} />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Processing</p>
              <h2>Active queue</h2>
            </div>
            <span className="live-pill">
              <span />
              Live
            </span>
          </div>
          <JobRows items={active.slice(0, 5)} />
        </section>
      </div>
    </>
  )
}

function Assets({ scope, openUpload }: { scope: Scope; openUpload: () => void }) {
  const [items, setItems] = useState<Asset[]>([])
  const [selected, setSelected] = useState<Asset | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [searchInfo, setSearchInfo] = useState<SemanticSearchResponse | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      if (query.trim()) {
        const result = await api.search(scope.organizationId, scope.projectId, query.trim())
        setSearchInfo(result)
        setItems(result.items.map((item) => item.asset))
      } else {
        const result = await api.assets(scope.organizationId, scope.projectId)
        setSearchInfo(null)
        setItems(result.items)
      }
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setLoading(false)
    }
  }, [scope, query])
  useEffect(() => {
    const timeout = setTimeout(() => void load(), 250)
    return () => clearTimeout(timeout)
  }, [load])
  return (
    <>
      <Header
        eyebrow="Media library"
        title="Assets"
        intro="Browse originals, inspect metadata, and control delivery privacy."
        action={
          <button className="primary-button" type="button" onClick={openUpload}>
            <Upload size={18} />
            Upload media
          </button>
        }
      />
      <div className="toolbar">
        <label className="search-field">
          <Search size={17} />
          <span className="sr-only">Search assets</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, metadata, text, or visual meaning"
          />
        </label>
        <span>{items.length} assets</span>
      </div>
      {error ? <Notice retry={() => void load()}>{error}</Notice> : null}
      {searchInfo ? (
        <div className="search-summary" role="status">
          <strong>{searchInfo.mode === 'hybrid' ? 'Hybrid search' : 'Lexical search'}</strong>
          <span>
            {searchInfo.degradedReason
              ? `Semantic results are temporarily unavailable (${searchInfo.degradedReason.replaceAll('_', ' ')}).`
              : searchInfo.mode === 'hybrid'
                ? 'Results combine exact matches with semantic similarity.'
                : 'Results use local full-text search; no AI provider is required.'}
          </span>
        </div>
      ) : null}
      <section className={searchInfo ? 'panel search-stage' : 'panel library-stage'}>
        {loading ? (
          <Loading label="Loading assets" />
        ) : (
          <AssetRows
            items={items}
            select={setSelected}
            scope={scope}
            variant={searchInfo ? 'explore' : 'archive'}
          />
        )}
      </section>
      {selected ? (
        <AssetDrawer
          scope={scope}
          selected={selected}
          close={() => setSelected(null)}
          saved={(next) =>
            setItems((current) => current.map((item) => (item.id === next.id ? next : item)))
          }
        />
      ) : null}
    </>
  )
}
function AssetDrawer({
  scope,
  selected,
  close,
  saved,
}: {
  scope: Scope
  selected: Asset
  close: () => void
  saved: (item: Asset) => void
}) {
  const dialogRef = useDialogKeyboard(close)
  const [asset, setAsset] = useState(selected)
  const [etag, setEtag] = useState('')
  const [error, setError] = useState('')
  const [derivativeMessage, setDerivativeMessage] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    void api
      .asset(scope.organizationId, scope.projectId, selected.publicId)
      .then((result) => {
        setAsset(result.asset)
        setEtag(result.etag)
      })
      .catch((caught) => setError(msg(caught)))
  }, [scope, selected.publicId])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      const next = await api.updateAsset(
        scope.organizationId,
        scope.projectId,
        asset.publicId,
        etag,
        {
          name: String(data.get('name')),
          folder: String(data.get('folder')),
          visibility: data.get('visibility') === 'public' ? 'public' : 'private',
        },
      )
      saved(next)
      close()
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  async function queueDerivative(input: CreateDerivativeRequest) {
    setPending(true)
    setError('')
    setDerivativeMessage('')
    try {
      const derivative = await api.createDerivative(
        scope.organizationId,
        scope.projectId,
        asset.publicId,
        asset.currentVersion,
        input,
      )
      setDerivativeMessage(
        derivative.state === 'ready'
          ? 'This derivative was already available.'
          : 'Derivative queued. Follow its progress on the Jobs page.',
      )
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  async function excludeFromAi() {
    setPending(true)
    setError('')
    setDerivativeMessage('')
    try {
      await api.setAssetAiExclusion(scope.organizationId, scope.projectId, asset.publicId, true)
      setDerivativeMessage(
        'This asset is excluded and its semantic vectors are queued for deletion.',
      )
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  const original = `/api/v1/organizations/${scope.organizationId}/projects/${scope.projectId}/assets/${asset.publicId}/versions/${asset.currentVersion}/original`
  return (
    <div className="drawer-backdrop">
      <aside
        ref={dialogRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-title"
      >
        <div className="drawer-heading">
          <div>
            <p className="eyebrow">Asset details</p>
            <h2 id="asset-title">{asset.name}</h2>
          </div>
          <button
            className="icon-plain"
            type="button"
            onClick={close}
            aria-label="Close asset details"
          >
            <X />
          </button>
        </div>
        <div className="asset-control-room">
          <section className="asset-stage" aria-label="Asset preview and technical metadata">
            <div className={`asset-hero ${asset.mediaKind}`}>
              {asset.mediaKind === 'image' && asset.state === 'ready' ? (
                <img src={original} alt={asset.name} />
              ) : null}
              <span>{asset.mediaKind}</span>
            </div>
            <dl className="metadata-grid">
              <div>
                <dt>Format</dt>
                <dd>{asset.version?.mimeType ?? 'Processing'}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{asset.version?.sizeBytes ? bytes(asset.version.sizeBytes) : '—'}</dd>
              </div>
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {asset.version?.width && asset.version.height
                    ? `${asset.version.width} × ${asset.version.height}`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{asset.state}</dd>
              </div>
            </dl>
            <a className="secondary-button wide" href={original} target="_blank" rel="noreferrer">
              <ArrowUpRight />
              Open original
            </a>
          </section>
          <div className="asset-inspector">
            {error ? <Notice>{error}</Notice> : null}
            {derivativeMessage ? (
              <div className="notice success-notice" role="status">
                <Check aria-hidden="true" size={18} />
                <p>{derivativeMessage}</p>
              </div>
            ) : null}
            <form className="form-stack" onSubmit={submit}>
              <div>
                <p className="eyebrow">Archive record</p>
                <h3>Identity & access</h3>
              </div>
              <Field label="Display name">
                <input name="name" required defaultValue={asset.name} />
              </Field>
              <Field label="Folder">
                <input name="folder" defaultValue={asset.folder} />
              </Field>
              <Field label="Privacy">
                <select name="visibility" defaultValue={asset.visibility}>
                  <option value="private">Private — authentication required</option>
                  <option value="public">Public — available by URL</option>
                </select>
              </Field>
              <button className="primary-button wide" disabled={pending || !etag} type="submit">
                {pending ? <LoaderCircle className="spin" /> : <Check />}Save changes
              </button>
            </form>
            {asset.state === 'ready' && asset.mediaKind !== 'image' ? (
              <section className="form-stack" aria-labelledby="derivative-actions-title">
                <div>
                  <p className="eyebrow">Processing</p>
                  <h3 id="derivative-actions-title">Create a derivative</h3>
                </div>
                {asset.mediaKind === 'video' ? (
                  <>
                    <button
                      className="secondary-button wide"
                      disabled={pending}
                      type="button"
                      onClick={() => void queueDerivative({ operation: 'video_poster' })}
                    >
                      Generate poster image
                    </button>
                    <button
                      className="secondary-button wide"
                      disabled={pending}
                      type="button"
                      onClick={() =>
                        void queueDerivative({ operation: 'video_transcode', preset: 'mp4-720p' })
                      }
                    >
                      Transcode to MP4 720p
                    </button>
                  </>
                ) : asset.version?.mimeType === 'application/pdf' ? (
                  <>
                    <button
                      className="secondary-button wide"
                      disabled={pending}
                      type="button"
                      onClick={() => void queueDerivative({ operation: 'pdf_thumbnail' })}
                    >
                      Generate PDF thumbnail
                    </button>
                    <button
                      className="secondary-button wide"
                      disabled={pending}
                      type="button"
                      onClick={() => void queueDerivative({ operation: 'pdf_text' })}
                    >
                      Extract searchable text
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary-button wide"
                    disabled={pending}
                    type="button"
                    onClick={() => void queueDerivative({ operation: 'office_preview' })}
                  >
                    Generate PDF preview
                  </button>
                )}
              </section>
            ) : null}
            <button
              className="secondary-button wide"
              type="button"
              disabled={pending}
              onClick={() => void excludeFromAi()}
            >
              <EyeOff /> Exclude from AI indexing
            </button>
          </div>
        </div>
      </aside>
    </div>
  )
}
function UploadModal({
  scope,
  close,
  done,
}: {
  scope: Scope
  close: () => void
  done: () => void
}) {
  const dialogRef = useDialogKeyboard(close)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const id = useId()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) {
      setError('Choose a file before uploading.')
      return
    }
    const data = new FormData(event.currentTarget)
    setPending(true)
    setError('')
    try {
      await api.upload(
        scope.organizationId,
        scope.projectId,
        file,
        String(data.get('name')) || file.name,
        String(data.get('folder')),
        data.get('visibility') === 'public' ? 'public' : 'private',
      )
      done()
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-title"
      >
        <div className="drawer-heading">
          <div>
            <p className="eyebrow">New original</p>
            <h2 id="upload-title">Upload media</h2>
          </div>
          <button className="icon-plain" type="button" onClick={close} aria-label="Close upload">
            <X />
          </button>
        </div>
        {error ? <Notice>{error}</Notice> : null}
        <form className="form-stack" onSubmit={submit}>
          <label className="drop-zone" htmlFor={id}>
            <CloudUpload />
            <strong>{file ? file.name : 'Choose an image, video, or document'}</strong>
            <span>{file ? bytes(file.size) : 'Content is validated on the server.'}</span>
            <input
              id={id}
              type="file"
              accept="image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <Field label="Display name">
            <input name="name" defaultValue={file?.name ?? ''} />
          </Field>
          <Field label="Folder">
            <input name="folder" placeholder="campaigns/autumn" />
          </Field>
          <Field label="Privacy">
            <select name="visibility" defaultValue="private">
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </Field>
          <button className="primary-button wide" type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="spin" /> : <Upload />}Upload original
          </button>
        </form>
      </section>
    </div>
  )
}

function ProjectModal({
  organizationId,
  close,
  done,
}: {
  organizationId: string
  close: () => void
  done: (project: Project) => void
}) {
  const dialogRef = useDialogKeyboard(close)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = String(new FormData(event.currentTarget).get('name'))
    setPending(true)
    setError('')
    try {
      done(await api.createProject(organizationId, name, slugify(name)))
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal compact-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-title"
      >
        <div className="drawer-heading">
          <div>
            <p className="eyebrow">New workspace</p>
            <h2 id="project-title">Create a project</h2>
          </div>
          <button
            className="icon-plain"
            type="button"
            onClick={close}
            aria-label="Close project form"
          >
            <X />
          </button>
        </div>
        {error ? <Notice>{error}</Notice> : null}
        <form className="form-stack" onSubmit={submit}>
          <Field label="Project name">
            <input name="name" required maxLength={100} placeholder="Product library" />
          </Field>
          <button className="primary-button wide" type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="spin" /> : <Plus />}Create project
          </button>
        </form>
      </section>
    </div>
  )
}

function Presets({ scope }: { scope: Scope }) {
  const [items, setItems] = useState<TransformPreset[]>([])
  const [error, setError] = useState('')
  const load = useCallback(
    () =>
      api
        .presets(scope.organizationId, scope.projectId)
        .then((result) => setItems(result.items))
        .catch((caught) => setError(msg(caught))),
    [scope],
  )
  useEffect(() => {
    void load()
  }, [load])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      await api.createPreset(
        scope.organizationId,
        scope.projectId,
        String(data.get('name')),
        String(data.get('transform')),
      )
      form.reset()
      await load()
    } catch (caught) {
      setError(msg(caught))
    }
  }
  return (
    <>
      <Header
        eyebrow="Reusable delivery"
        title="Transform presets"
        intro="Name and version common image transformations for stable delivery URLs."
      />
      {error ? <Notice>{error}</Notice> : null}
      <div className="split-layout">
        <section className="panel padded">
          <h2>Create a preset</h2>
          <p className="section-copy">
            Example: <code>w_1200,h_630,fit_cover,f_webp,q_82</code>
          </p>
          <form className="form-stack" onSubmit={submit}>
            <Field label="Preset name">
              <input name="name" required pattern="[a-z][a-z0-9-]*" placeholder="social-card" />
            </Field>
            <Field label="Transform specification">
              <input name="transform" required placeholder="w_1200,h_630,fit_cover,f_webp,q_82" />
            </Field>
            <button className="primary-button" type="submit">
              <Plus />
              Create preset
            </button>
          </form>
        </section>
        <ListPanel title="Available presets" count={items.length}>
          {items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>{item.selector}</small>
              </div>
              <code>{item.canonicalSpec}</code>
              <span>v{item.version}</span>
            </article>
          ))}
        </ListPanel>
      </div>
    </>
  )
}
function Jobs({ scope }: { scope: Scope }) {
  const [items, setItems] = useState<Job[]>([])
  const [error, setError] = useState('')
  const load = useCallback(
    () =>
      api
        .jobs(scope.organizationId, scope.projectId)
        .then((result) => setItems(result.items))
        .catch((caught) => setError(msg(caught))),
    [scope],
  )
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])
  return (
    <>
      <Header
        eyebrow="Worker activity"
        title="Jobs"
        intro="Live progress, retries, and actionable processing failures."
        action={
          <button className="secondary-button" type="button" onClick={() => void load()}>
            <RefreshCw />
            Refresh
          </button>
        }
      />
      {error ? <Notice retry={() => void load()}>{error}</Notice> : null}
      <section className="panel">
        <JobRows items={items} />
      </section>
    </>
  )
}
function ListPanel({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      <div className="table-list">{children}</div>
    </section>
  )
}
function Keys({ scope }: { scope: Scope }) {
  const [items, setItems] = useState<ApiKey[]>([])
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(
    () =>
      api
        .apiKeys(scope.organizationId, scope.projectId)
        .then((result) => setItems(result.items))
        .catch((caught) => setError(msg(caught))),
    [scope],
  )
  useEffect(() => {
    void load()
  }, [load])
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    try {
      const result = await api.createApiKey(
        scope.organizationId,
        scope.projectId,
        String(new FormData(form).get('name')),
      )
      setSecret(result.secret)
      form.reset()
      await load()
    } catch (caught) {
      setError(msg(caught))
    }
  }
  return (
    <>
      <Header
        eyebrow="Programmatic access"
        title="API keys"
        intro="Issue scoped credentials for REST API and transformation URL clients."
      />
      {error ? <Notice>{error}</Notice> : null}
      {secret ? (
        <div className="secret-callout" role="status">
          <div>
            <strong>Copy this key now</strong>
            <p>It will not be shown again.</p>
            <code>{secret}</code>
          </div>
          <button type="button" onClick={() => void navigator.clipboard.writeText(secret)}>
            <Clipboard />
            Copy
          </button>
        </div>
      ) : null}
      <div className="split-layout">
        <section className="panel padded">
          <h2>Create a key</h2>
          <p className="section-copy">
            Default access can read and write assets without delete permission.
          </p>
          <form className="form-stack" onSubmit={create}>
            <Field label="Key name">
              <input name="name" required placeholder="Production website" />
            </Field>
            <button className="primary-button" type="submit">
              <Plus />
              Create key
            </button>
          </form>
        </section>
        <ListPanel title="Project keys" count={items.filter((item) => !item.revokedAt).length}>
          {items.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.prefix ?? 'Hidden prefix'} · {item.scopes.join(', ')}
                </small>
              </div>
              <span>{item.revokedAt ? 'Revoked' : 'Active'}</span>
              {!item.revokedAt ? (
                <button
                  className="danger-text"
                  type="button"
                  onClick={async () => {
                    await api.revokeApiKey(scope.organizationId, scope.projectId, item.id)
                    await load()
                  }}
                >
                  Revoke
                </button>
              ) : null}
            </article>
          ))}
        </ListPanel>
      </div>
    </>
  )
}
function Usage({ scope }: { scope: Scope }) {
  const [data, setData] = useState<ProjectStorageOverview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api
      .storage(scope.organizationId, scope.projectId)
      .then(setData)
      .catch((caught) => setError(msg(caught)))
  }, [scope])
  return (
    <>
      <Header
        eyebrow="Capacity"
        title="Storage & health"
        intro="Understand quota use, object state, derivative cache, and backend health."
      />
      {error ? <Notice>{error}</Notice> : null}
      {data ? (
        <div className="stats-layout">
          <section className="panel padded">
            <h2>{bytes(data.usage.usedBytes)} used</h2>
            <div className="large-meter">
              <span
                style={{
                  width: `${Math.min(100, (data.usage.usedBytes / data.usage.quotaBytes) * 100)}%`,
                }}
              />
            </div>
            <p>
              {bytes(data.usage.quotaRemainingBytes)} remains of {bytes(data.usage.quotaBytes)}.
            </p>
          </section>
          <section className="panel padded">
            <dl className="definition-list">
              <div>
                <dt>Backend</dt>
                <dd>{data.backend}</dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd className={`health ${data.health.status}`}>{data.health.status}</dd>
              </div>
              <div>
                <dt>Available objects</dt>
                <dd>{data.objects.available}</dd>
              </div>
              <div>
                <dt>Active uploads</dt>
                <dd>{data.uploads.active}</dd>
              </div>
              <div>
                <dt>Ready derivatives</dt>
                <dd>{data.derivatives.ready}</dd>
              </div>
              <div>
                <dt>Failed operations</dt>
                <dd>{data.objects.failed + data.uploads.failed + data.derivatives.failed}</dd>
              </div>
            </dl>
          </section>
        </div>
      ) : (
        <Loading label="Checking storage" />
      )}
    </>
  )
}
function Audit({ scope }: { scope: Scope }) {
  const [items, setItems] = useState<AuditEvent[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    void api
      .audit(scope.organizationId, scope.projectId)
      .then((result) => setItems(result.items))
      .catch((caught) => setError(msg(caught)))
  }, [scope])
  return (
    <>
      <Header
        eyebrow="Accountability"
        title="Audit history"
        intro="A chronological record of changes made by people, keys, and the system."
      />
      {error ? <Notice>{error}</Notice> : null}
      <section className="panel">
        <div className="timeline">
          {items.length ? (
            items.map((item) => (
              <article key={item.id}>
                <span className="timeline-mark" />
                <div>
                  <strong>{item.action.replaceAll('.', ' ')}</strong>
                  <p>
                    {item.actorType} · {item.targetType}
                  </p>
                </div>
                <time dateTime={item.createdAt}>{ago(item.createdAt)}</time>
              </article>
            ))
          ) : (
            <Empty
              icon={<History />}
              title="No audit events"
              copy="Project activity will be recorded here."
            />
          )}
        </div>
      </section>
    </>
  )
}
function Settings({ scope, project }: { scope: Scope; project: Project }) {
  const [semantic, setSemantic] = useState<SemanticSearchSettings | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const loadSemantic = useCallback(async () => {
    setError('')
    try {
      setSemantic(await api.semanticSettings(scope.organizationId, scope.projectId))
    } catch (caught) {
      setError(msg(caught))
    }
  }, [scope])
  useEffect(() => void loadSemantic(), [loadSemantic])
  async function saveSemantic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    setMessage('')
    const data = new FormData(event.currentTarget)
    try {
      const next = await api.updateSemanticSettings(scope.organizationId, scope.projectId, {
        enabled: data.get('enabled') === 'on',
        allowPrivateAssets: data.get('allowPrivateAssets') === 'on',
        monthlyBudgetMicroUsd: Math.round(Number(data.get('monthlyBudgetUsd')) * 1_000_000),
        maxAssetsPerRun: Number(data.get('maxAssetsPerRun')),
        concurrency: Number(data.get('concurrency')),
      })
      setSemantic(next)
      setMessage('Semantic-search settings saved.')
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  async function reindex() {
    setPending(true)
    setError('')
    setMessage('')
    try {
      await api.startSemanticReindex(scope.organizationId, scope.projectId)
      setMessage(
        'A candidate index is queued. The current index remains active until evaluation passes.',
      )
    } catch (caught) {
      setError(msg(caught))
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <Header
        eyebrow="Project configuration"
        title="Settings"
        intro="Stable identifiers and delivery routes for this project."
      />
      {error ? <Notice retry={() => void loadSemantic()}>{error}</Notice> : null}
      {message ? (
        <div className="notice success-notice" role="status">
          {message}
        </div>
      ) : null}
      <div className="split-layout">
        <section className="panel padded">
          <h2>Project identity</h2>
          <dl className="definition-list">
            <div>
              <dt>Name</dt>
              <dd>{project.name}</dd>
            </div>
            <div>
              <dt>Slug</dt>
              <dd>{project.slug}</dd>
            </div>
            <div>
              <dt>Project ID</dt>
              <dd>
                <code>{scope.projectId}</code>
              </dd>
            </div>
            <div>
              <dt>Organization ID</dt>
              <dd>
                <code>{scope.organizationId}</code>
              </dd>
            </div>
          </dl>
        </section>
        <section className="panel padded">
          <h2>Optional AI capabilities</h2>
          {!semantic ? (
            <Loading label="Loading semantic-search settings" />
          ) : (
            <form className="form-stack" onSubmit={saveSemantic}>
              <div className="optional-feature">
                {semantic.enabled ? <Search /> : <EyeOff />}
                <div>
                  <strong>
                    {semantic.enabled ? 'Semantic search enabled' : 'Semantic search off'}
                  </strong>
                  <p>
                    {semantic.deploymentEnabled && semantic.providerConfigured
                      ? `${semantic.provider} is configured. Core media features remain independent.`
                      : 'Start the optional AI Compose profile to enable provider-backed indexing.'}
                  </p>
                </div>
              </div>
              <label className="check-row">
                <input name="enabled" type="checkbox" defaultChecked={semantic.enabled} />
                Enable provider-backed semantic search for this project
              </label>
              <label className="check-row">
                <input
                  name="allowPrivateAssets"
                  type="checkbox"
                  defaultChecked={semantic.allowPrivateAssets}
                />
                Allow private assets to be sent to the configured provider
              </label>
              <Field
                label="Monthly spend ceiling (USD)"
                hint="The worker stops before further provider operations once this ceiling is reached."
              >
                <input
                  name="monthlyBudgetUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={(semantic.monthlyBudgetMicroUsd / 1_000_000).toFixed(2)}
                />
              </Field>
              <Field label="Maximum assets per indexing run">
                <input
                  name="maxAssetsPerRun"
                  type="number"
                  min="1"
                  max="10000"
                  defaultValue={semantic.maxAssetsPerRun}
                />
              </Field>
              <Field label="Indexing concurrency">
                <input
                  name="concurrency"
                  type="number"
                  min="1"
                  max="16"
                  defaultValue={semantic.concurrency}
                />
              </Field>
              <p>
                This month: ${(semantic.monthlySpendMicroUsd / 1_000_000).toFixed(2)} · Active
                index:{' '}
                {semantic.activeIndex ? `${semantic.activeIndex.indexedAssets} assets` : 'none'}
              </p>
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={pending || !semantic.enabled}
                  onClick={() => void reindex()}
                >
                  <RefreshCw size={16} /> Build candidate index
                </button>
                <button className="primary-button" type="submit" disabled={pending}>
                  {pending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save
                  AI settings
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </>
  )
}
