import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Files,
  Gauge,
  KeyRound,
  LayoutGrid,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from 'lucide-react'

const assets = [
  {
    accent: 'coral',
    detail: '3840 × 2160 · 8.4 MB',
    format: 'JPG',
    name: 'Desert campaign',
    privacy: 'Public',
    time: '2 minutes ago',
  },
  {
    accent: 'violet',
    detail: '00:42 · 24.1 MB',
    format: 'MP4',
    name: 'Studio walkthrough',
    privacy: 'Private',
    time: '18 minutes ago',
  },
  {
    accent: 'blue',
    detail: '16 pages · 2.7 MB',
    format: 'PDF',
    name: 'Brand guidelines',
    privacy: 'Private',
    time: 'Yesterday',
  },
]

const navItems = [
  { icon: LayoutGrid, label: 'Overview', selected: true },
  { icon: Files, label: 'Assets' },
  { icon: SlidersHorizontal, label: 'Presets' },
  { icon: Activity, label: 'Jobs', count: '3' },
]

export function App() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>Aeonic</span>
        </div>

        <nav>
          <p className="nav-label">Workspace</p>
          <ul className="nav-list">
            {navItems.map(({ count, icon: Icon, label, selected }) => (
              <li key={label}>
                <button className={selected ? 'nav-item is-selected' : 'nav-item'} type="button">
                  <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                  <span>{label}</span>
                  {count ? <span className="nav-count">{count}</span> : null}
                </button>
              </li>
            ))}
          </ul>

          <p className="nav-label secondary-label">Manage</p>
          <ul className="nav-list">
            <li>
              <button className="nav-item" type="button">
                <KeyRound aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>API keys</span>
              </button>
            </li>
            <li>
              <button className="nav-item" type="button">
                <Gauge aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>Usage</span>
              </button>
            </li>
            <li>
              <button className="nav-item" type="button">
                <Settings2 aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>Settings</span>
              </button>
            </li>
          </ul>
        </nav>

        <div className="sidebar-footer">
          <button className="support-link" type="button">
            <CircleHelp aria-hidden="true" size={17} />
            Documentation
          </button>
          <button className="profile" type="button" aria-label="Open account menu">
            <span className="avatar">IS</span>
            <span className="profile-copy">
              <strong>Ibrahim</strong>
              <small>Owner</small>
            </span>
            <ChevronDown aria-hidden="true" size={16} />
          </button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="project-switcher" type="button" aria-label="Switch project">
            <span className="project-dot" aria-hidden="true" />
            Studio archive
            <ChevronDown aria-hidden="true" size={15} />
          </button>
          <div className="topbar-actions">
            <label className="search-field">
              <Search aria-hidden="true" size={17} />
              <span className="sr-only">Search media</span>
              <input type="search" placeholder="Search media" />
              <kbd>⌘ K</kbd>
            </label>
            <button className="icon-button" type="button" aria-label="Create new item">
              <Plus aria-hidden="true" size={20} />
            </button>
          </div>
        </header>

        <main id="main-content">
          <section className="intro" aria-labelledby="page-title">
            <div>
              <p className="eyebrow">Sunday, 27 September</p>
              <h1 id="page-title">Good evening, Ibrahim.</h1>
              <p>Everything in your media pipeline is moving smoothly.</p>
            </div>
            <button className="primary-button" type="button">
              <Upload aria-hidden="true" size={18} />
              Upload media
            </button>
          </section>

          <section className="metrics-grid" aria-label="Workspace statistics">
            <article className="metric-card">
              <span className="metric-icon amber">
                <Files aria-hidden="true" size={19} />
              </span>
              <div>
                <p>Total assets</p>
                <strong>1,284</strong>
                <small>
                  <span className="positive">+24</span> this month
                </small>
              </div>
            </article>
            <article className="metric-card">
              <span className="metric-icon blue">
                <Gauge aria-hidden="true" size={19} />
              </span>
              <div>
                <p>Storage used</p>
                <strong>18.6 GB</strong>
                <small>of 50 GB available</small>
              </div>
              <div
                className="storage-meter"
                role="progressbar"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={37}
              >
                <span />
              </div>
            </article>
            <article className="metric-card">
              <span className="metric-icon mint">
                <Activity aria-hidden="true" size={19} />
              </span>
              <div>
                <p>Jobs today</p>
                <strong>47</strong>
                <small>
                  <span className="status-dot" /> 3 processing now
                </small>
              </div>
            </article>
            <article className="metric-card featured-card">
              <Sparkles aria-hidden="true" size={22} />
              <div>
                <p>Delivery success</p>
                <strong>99.98%</strong>
                <small>Across the last 30 days</small>
              </div>
            </article>
          </section>

          <div className="content-grid">
            <section className="panel recent-panel" aria-labelledby="recent-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Library</p>
                  <h2 id="recent-title">Recent media</h2>
                </div>
                <button className="text-button" type="button">
                  View all <ArrowUpRight aria-hidden="true" size={16} />
                </button>
              </div>
              <div className="asset-list">
                {assets.map((asset) => (
                  <button className="asset-row" type="button" key={asset.name}>
                    <span className={`asset-preview ${asset.accent}`}>
                      <span>{asset.format}</span>
                    </span>
                    <span className="asset-info">
                      <strong>{asset.name}</strong>
                      <small>{asset.detail}</small>
                    </span>
                    <span className={`privacy ${asset.privacy.toLowerCase()}`}>
                      {asset.privacy}
                    </span>
                    <time>{asset.time}</time>
                  </button>
                ))}
              </div>
            </section>

            <section className="panel queue-panel" aria-labelledby="queue-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Processing</p>
                  <h2 id="queue-title">Active queue</h2>
                </div>
                <span className="live-pill">
                  <span /> Live
                </span>
              </div>
              <ol className="queue-list">
                <li>
                  <span className="queue-number">01</span>
                  <div>
                    <strong>Studio walkthrough</strong>
                    <small>Generating web delivery</small>
                    <div
                      className="progress"
                      role="progressbar"
                      aria-label="Studio walkthrough progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={72}
                    >
                      <span />
                    </div>
                  </div>
                  <b>72%</b>
                </li>
                <li>
                  <span className="queue-number">02</span>
                  <div>
                    <strong>Product detail set</strong>
                    <small>Optimizing 12 images</small>
                    <div
                      className="progress second"
                      role="progressbar"
                      aria-label="Product detail set progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={38}
                    >
                      <span />
                    </div>
                  </div>
                  <b>38%</b>
                </li>
                <li className="queued">
                  <span className="queue-number">03</span>
                  <div>
                    <strong>Brand guidelines</strong>
                    <small>Waiting for worker</small>
                  </div>
                  <b>Queued</b>
                </li>
              </ol>
              <button className="queue-action" type="button">
                Open job monitor
              </button>
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}
