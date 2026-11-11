import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from './api'
import './App.css'

const navigation = [
  { id: 'overview', label: 'Overview', symbol: '◫' },
  { id: 'accounts', label: 'Accounts', symbol: '▤' },
  { id: 'transfers', label: 'Transfer', symbol: '⇄' },
  { id: 'activity', label: 'Activity', symbol: '◷' },
  { id: 'profile', label: 'Profile & settings', symbol: '○' },
]

function createRequestKey() {
  return globalThis.crypto.randomUUID()
}

function money(value, currency = 'INR') {
  const amount = Number(value || 0)
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0)
}

function balanceSummary(accounts) {
  const totals = new Map()
  accounts
    .filter((account) => account.status === 'ACTIVE')
    .forEach((account) => {
      totals.set(account.currency, (totals.get(account.currency) || 0) + Number(account.balance || 0))
    })
  return totals.size
    ? [...totals].map(([currency, amount]) => money(amount, currency)).join(' · ')
    : money(0)
}

function initials(name = '') {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'BV'
}

function dateLabel(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function App() {
  const [user, setUser] = useState(null)
  const [page, setPage] = useState('overview')
  const [authMode, setAuthMode] = useState('login')
  const [booting, setBooting] = useState(true)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [accounts, setAccounts] = useState([])
  const [transfers, setTransfers] = useState([])
  const [adminData, setAdminData] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })
  const [transferForm, setTransferForm] = useState({
    fromAccountId: '',
    toAccountNumber: '',
    amount: '',
    description: '',
  })
  const [idempotencyKey, setIdempotencyKey] = useState(createRequestKey)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [today] = useState(() => new Date())

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.status === 'ACTIVE'),
    [accounts],
  )

  useEffect(() => {
    let active = true
    apiRequest('/auth/me')
      .then(({ user: currentUser }) => {
        if (active) {
          setLoading(true)
          setUser(currentUser)
        }
      })
      .catch((requestError) => {
        if (!active) return
        if (requestError.status !== 401) setError(requestError.message)
      })
      .finally(() => {
        if (active) setBooting(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!user) return undefined
    let active = true

    const load = async () => {
      try {
        const [accountResult, transferResult] = await Promise.all([
          apiRequest('/accounts'),
          apiRequest(user.role === 'ADMIN' ? '/admin/transfers?limit=100' : '/transfers'),
        ])
        if (!active) return
        setAccounts(accountResult.accounts)
        setTransfers(transferResult.transfers)

        if (user.role === 'ADMIN') {
          const [overviewResult, usersResult, adminTransfers, auditResult] = await Promise.all([
            apiRequest('/admin/overview'),
            apiRequest('/admin/users?limit=8'),
            apiRequest('/admin/transfers?limit=8'),
            apiRequest('/admin/audit-logs?limit=8'),
          ])
          if (!active) return
          setAdminData({
            overview: overviewResult.overview,
            users: usersResult.users,
            transfers: adminTransfers.transfers,
            auditLogs: auditResult.auditLogs,
          })
        } else {
          setAdminData(null)
        }
      } catch (requestError) {
        if (active) setError(requestError.message)
      } finally {
        if (active) setLoading(false)
      }
    }

    load()
    return () => {
      active = false
    }
  }, [user, refreshVersion])

  const changePage = (nextPage) => {
    setPage(nextPage)
    setError('')
    setNotice('')
    setMobileMenuOpen(false)
  }

  const submitAuth = async (event) => {
    event.preventDefault()
    setSaving(true)
    setLoading(true)
    setError('')
    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register'
      const { user: signedInUser } = await apiRequest(path, {
        method: 'POST',
        body: authForm,
      })
      setUser(signedInUser)
      setPage('overview')
      setAuthForm({ name: '', email: '', password: '' })
      setNotice(authMode === 'login' ? 'Welcome back.' : 'Your account is ready.')
    } catch (requestError) {
      setError(requestError.message)
      setLoading(false)
    } finally {
      setSaving(false)
    }
  }

  const signOut = async () => {
    setSaving(true)
    try {
      await apiRequest('/auth/logout', { method: 'POST' })
      setUser(null)
      setAccounts([])
      setTransfers([])
      setAdminData(null)
      setPage('overview')
      setNotice('')
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  const createAccount = async () => {
    setSaving(true)
    setError('')
    try {
      await apiRequest('/accounts', { method: 'POST', body: { currency: 'INR' } })
      setLoading(true)
      setRefreshVersion((version) => version + 1)
      setNotice('Account created. It will be available after an administrator activates it.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  const updateAccountStatus = async (accountId, status) => {
    setSaving(true)
    setError('')
    try {
      await apiRequest(`/admin/accounts/${accountId}/status`, {
        method: 'PATCH',
        body: { status },
      })
      setLoading(true)
      setRefreshVersion((version) => version + 1)
      setNotice(`Account status changed to ${status.toLowerCase()}.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  const submitTransfer = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await apiRequest('/transfers', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: transferForm,
      })
      setTransferForm({
        fromAccountId: '',
        toAccountNumber: '',
        amount: '',
        description: '',
      })
      setIdempotencyKey(createRequestKey())
      setLoading(true)
      setRefreshVersion((version) => version + 1)
      setNotice(`Transfer complete · ${money(result.transfer.amount, result.transfer.currency)}`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  if (booting) {
    return <div className="app-loader"><span className="spinner" /> Securing your session</div>
  }

  if (!user) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        form={authForm}
        setForm={setAuthForm}
        onSubmit={submitAuth}
        saving={saving}
        error={error}
      />
    )
  }

  const visibleNavigation = user.role === 'ADMIN'
    ? [...navigation.filter((item) => item.id !== 'transfers'), { id: 'admin', label: 'Admin console', symbol: '⌘' }]
    : navigation

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); changePage('overview') }}>
          <span className="brand-mark"><span /></span>
          <span>balance<span className="brand-light">vault</span></span>
        </a>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          {visibleNavigation.map((item) => (
            <button
              className={`nav-item ${page === item.id ? 'nav-item-active' : ''}`}
              key={item.id}
              onClick={() => changePage(item.id)}
              type="button"
            >
              <span className="nav-symbol" aria-hidden="true">{item.symbol}</span>
              <span>{item.label}</span>
              {item.id === 'admin' && <span className="nav-pill">ADMIN</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <span className="secure-icon">✓</span>
            <span><strong>Protected banking</strong><small>Encrypted session</small></span>
          </div>
          <button className="profile-mini" onClick={() => changePage('profile')} type="button">
            <span className="avatar">{initials(user.name)}</span>
            <span className="profile-mini-copy"><strong>{user.name}</strong><small>{user.role === 'ADMIN' ? 'Administrator' : 'Account holder'}</small></span>
            <span className="profile-more">···</span>
          </button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button
            aria-label="Toggle navigation"
            className="menu-toggle"
            onClick={() => setMobileMenuOpen((isOpen) => !isOpen)}
            type="button"
          >
            <span /><span /><span />
          </button>
          <div className="breadcrumb"><span>BalanceVault</span><b>/</b><strong>{pageTitle(page)}</strong></div>
          <div className="topbar-right">
            <span className="secure-status"><i /> Secure connection</span>
            <span className="topbar-date">{new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(today)}</span>
            <button className="avatar avatar-top" onClick={() => changePage('profile')} title="Open profile" type="button">{initials(user.name)}</button>
          </div>
        </header>

        <div className="page-content">
          {(error || notice) && (
            <div className={`alert ${error ? 'alert-error' : 'alert-success'}`} role={error ? 'alert' : 'status'}>
              <span>{error ? '!' : '✓'}</span>
              <p>{error || notice}</p>
              <button onClick={() => { setError(''); setNotice('') }} aria-label="Dismiss message" type="button">×</button>
            </div>
          )}

          {loading && <div className="loading-line"><span className="spinner spinner-small" /> Updating your accounts…</div>}
          {page === 'overview' && (
            <OverviewPage
              user={user}
              accounts={accounts}
              transfers={transfers}
              today={today}
              onNavigate={changePage}
            />
          )}
          {page === 'accounts' && (
            <AccountsPage
              accounts={accounts}
              isAdmin={user.role === 'ADMIN'}
              saving={saving}
              onCreate={createAccount}
              onStatusChange={updateAccountStatus}
            />
          )}
          {page === 'transfers' && (
            <TransferPage
              accounts={activeAccounts}
              form={transferForm}
              setForm={(nextForm) => {
                setTransferForm(nextForm)
                setIdempotencyKey(createRequestKey())
              }}
              saving={saving}
              onSubmit={submitTransfer}
            />
          )}
          {page === 'activity' && <ActivityPage transfers={transfers} accounts={accounts} isAdmin={user.role === 'ADMIN'} />}
          {page === 'profile' && <ProfilePage user={user} onSignOut={signOut} saving={saving} />}
          {page === 'admin' && user.role === 'ADMIN' && (
            <AdminPage
              data={adminData}
              accounts={accounts}
              saving={saving}
              onStatusChange={updateAccountStatus}
            />
          )}
        </div>
        <footer className="app-footer">
          <span>BalanceVault · Private banking, made clear.</span>
          <span><i /> All systems operational</span>
        </footer>
      </main>
    </div>
  )
}

function pageTitle(page) {
  return {
    overview: 'Overview',
    accounts: 'Accounts',
    transfers: 'Money transfer',
    activity: 'Activity',
    profile: 'Profile & settings',
    admin: 'Admin console',
  }[page] || 'Overview'
}

function AuthScreen({ mode, setMode, form, setForm, onSubmit, saving, error }) {
  const isLogin = mode === 'login'
  return (
    <main className="auth-page">
      <div className="auth-art">
        <a className="brand brand-light" href="#">
          <span className="brand-mark"><span /></span>
          <span>balance<span className="brand-light">vault</span></span>
        </a>
        <div className="auth-art-content">
          <div className="art-eyebrow"><span /> YOUR MONEY, IN BALANCE</div>
          <h1>Clarity for every<br /><em>move you make.</em></h1>
          <p>One calm place to see your money, move it with confidence, and keep every detail in view.</p>
          <div className="art-card">
            <div className="art-card-top"><span>YOUR BALANCE</span><span className="art-dots">•••</span></div>
            <strong>₹ ••••••</strong>
            <div className="art-card-bottom"><span>•••• &nbsp;•••• &nbsp;•••• &nbsp;2084</span><span>VISA</span></div>
          </div>
        </div>
        <div className="art-footer"><span>Banking built around you.</span><span>© BalanceVault</span></div>
      </div>

      <section className="auth-panel">
        <div className="auth-mobile-brand brand">
          <span className="brand-mark"><span /></span>
          <span>balance<span className="brand-light">vault</span></span>
        </div>
        <div className="auth-form-wrap">
          <div className="auth-kicker">{isLogin ? 'WELCOME BACK' : 'GET STARTED'}</div>
          <h2>{isLogin ? 'Sign in to your account' : 'Create your account'}</h2>
          <p className="auth-subtitle">{isLogin ? 'Your finances, right where you left them.' : 'A thoughtful way to manage your money.'}</p>
          {error && <div className="alert alert-error auth-alert" role="alert"><span>!</span><p>{error}</p></div>}
          <form className="auth-form" onSubmit={onSubmit}>
            {!isLogin && (
              <label>
                Full name
                <input
                  autoComplete="name"
                  maxLength="80"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Your name"
                  required
                  value={form.name}
                />
              </label>
            )}
            <label>
              Email address
              <input
                autoComplete="email"
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="you@example.com"
                required
                type="email"
                value={form.email}
              />
            </label>
            <label>
              Password
              <input
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                maxLength="72"
                minLength={isLogin ? undefined : '8'}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                placeholder={isLogin ? 'Enter your password' : 'At least 8 characters'}
                required
                type="password"
                value={form.password}
              />
            </label>
            {isLogin && <div className="form-meta"><span>Protected by secure, encrypted sessions</span></div>}
            <button className="button button-primary auth-submit" disabled={saving} type="submit">
              {saving ? <><span className="spinner spinner-light" /> Please wait…</> : isLogin ? 'Sign in securely' : 'Create account'}
              {!saving && <span aria-hidden="true">→</span>}
            </button>
          </form>
          <p className="auth-switch">
            {isLogin ? 'New to BalanceVault?' : 'Already have an account?'}
            <button onClick={() => { setMode(isLogin ? 'register' : 'login'); }} type="button">
              {isLogin ? 'Create an account' : 'Sign in'}
            </button>
          </p>
          <div className="auth-privacy"><span>⌑</span> Your information is private and protected.</div>
        </div>
        <div className="auth-bottom">By continuing, you agree to our <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</div>
      </section>
    </main>
  )
}

function PageHeading({ eyebrow, title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  )
}

function OverviewPage({ user, accounts, transfers, today, onNavigate }) {
  const firstName = user.name.split(' ')[0]
  const recent = transfers.slice(0, 4)
  return (
    <>
      <PageHeading
        eyebrow={new Intl.DateTimeFormat('en-IN', { weekday: 'long', month: 'long', day: 'numeric' }).format(today).toUpperCase()}
        title={`Good day, ${firstName}.`}
        description="Here’s your financial snapshot at a glance."
        action={<button className="button button-primary" onClick={() => onNavigate('transfers')} type="button"><span>⇄</span> Make a transfer</button>}
      />
      <section className="balance-banner">
        <div className="balance-main">
          <div className="balance-label"><span className="balance-icon">₹</span> TOTAL AVAILABLE BALANCE <span className="balance-eye">◉</span></div>
          <div className="balance-amount">{balanceSummary(accounts)}</div>
          <div className="balance-caption">Across {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} · Active accounts only</div>
        </div>
        <div className="balance-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="orbit-core"><span>BV</span></div>
          <i className="orbit-dot dot-one" /><i className="orbit-dot dot-two" />
        </div>
        <div className="balance-secure"><span>✓</span> Your funds are protected</div>
      </section>

      <div className="stats-grid">
        <StatCard label="Total accounts" value={accounts.length} icon="▤" note="Across all currencies" />
        <StatCard label="Active accounts" value={accounts.filter((account) => account.status === 'ACTIVE').length} icon="✓" note="Ready for transactions" positive />
        <StatCard label="Recent transfers" value={transfers.length} icon="⇄" note="Your latest activity" />
      </div>

      <section className="content-grid">
        <div className="panel recent-panel">
          <div className="panel-heading">
            <div><h2>Recent activity</h2><p>Your latest money movements</p></div>
            <button className="text-button" onClick={() => onNavigate('activity')} type="button">View all <span>→</span></button>
          </div>
          {recent.length ? (
            <div className="activity-list">
              {recent.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} accounts={accounts} isAdmin={user.role === 'ADMIN'} />
              ))}
            </div>
          ) : <EmptyState title="No activity yet" text="Completed transfers will appear here." />}
        </div>
        <div className="panel account-preview">
          <div className="panel-heading">
            <div><h2>Your accounts</h2><p>A view across your accounts</p></div>
            <button className="text-button" onClick={() => onNavigate('accounts')} type="button">Manage <span>→</span></button>
          </div>
          {accounts.length ? accounts.slice(0, 3).map((account) => <AccountRow account={account} key={account.id} />) : (
            <div className="account-empty">
              <div className="empty-icon">▤</div>
              <strong>Start with your first account</strong>
              <p>Open a BalanceVault account to get started.</p>
              <button className="button button-secondary" onClick={() => onNavigate('accounts')} type="button">Explore accounts</button>
            </div>
          )}
        </div>
      </section>
      <div className="tip-strip"><span>✦</span><p><strong>A little peace of mind.</strong> Every transfer is recorded in your secure transaction history.</p><button onClick={() => onNavigate('activity')} type="button">View activity →</button></div>
    </>
  )
}

function StatCard({ label, value, icon, note, positive }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${positive ? 'stat-icon-green' : ''}`}>{icon}</div>
      <div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
      <span className="stat-arrow">↗</span>
    </div>
  )
}

function AccountsPage({ accounts, isAdmin, saving, onCreate, onStatusChange }) {
  return (
    <>
      <PageHeading
        eyebrow="YOUR MONEY, ORGANIZED"
        title="Accounts"
        description="See your balances and keep your accounts in order."
        action={!isAdmin && <button className="button button-primary" disabled={saving} onClick={onCreate} type="button"><span>＋</span> Open an account</button>}
      />
      <div className="account-page-summary">
        <div><span>AVAILABLE BALANCE</span><strong>{balanceSummary(accounts)}</strong></div>
        <div><span>ACCOUNT COUNT</span><strong>{accounts.length.toString().padStart(2, '0')} <small>accounts</small></strong></div>
        <div><span>NEEDS ACTIVATION</span><strong>{accounts.filter((account) => account.status === 'PENDING').length.toString().padStart(2, '0')}</strong></div>
      </div>
      <div className="accounts-grid">
        {accounts.map((account) => (
          <AccountCard
            account={account}
            isAdmin={isAdmin}
            key={account.id}
            onStatusChange={onStatusChange}
            saving={saving}
          />
        ))}
        {!accounts.length && (
          <div className="panel empty-panel">
            <div className="empty-icon">▤</div>
            <h2>No accounts to show</h2>
            <p>{isAdmin ? 'Accounts created by customers will appear here.' : 'Open an account to begin your BalanceVault journey.'}</p>
            {!isAdmin && <button className="button button-primary" disabled={saving} onClick={onCreate} type="button">Open an account</button>}
          </div>
        )}
      </div>
    </>
  )
}

function AccountCard({ account, isAdmin, onStatusChange, saving }) {
  return (
    <article className={`account-card ${account.status === 'ACTIVE' ? 'account-card-active' : ''}`}>
      <div className="account-card-top">
        <div className="account-card-brand"><span className="brand-mark brand-mark-small"><span /></span> BalanceVault</div>
        <StatusBadge status={account.status} />
      </div>
      <span className="account-card-label">AVAILABLE BALANCE</span>
      <strong className="account-card-balance">{money(account.balance, account.currency)}</strong>
      <div className="account-card-number">{account.accountNumber}</div>
      <div className="account-card-bottom">
        <span>{account.currency} · {dateLabel(account.createdAt)}</span>
        {isAdmin && account.status !== 'CLOSED' && (
          <select
            aria-label={`Update status for account ${account.accountNumber}`}
            disabled={saving}
            onChange={(event) => onStatusChange(account.id, event.target.value)}
            value={account.status}
          >
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="FROZEN">Frozen</option>
            <option value="CLOSED">Close account</option>
          </select>
        )}
      </div>
    </article>
  )
}

function AccountRow({ account }) {
  return (
    <div className="account-row">
      <div className="account-row-icon">₹</div>
      <div className="account-row-copy"><strong>{account.accountNumber}</strong><span>{account.currency} · <StatusBadge status={account.status} /></span></div>
      <strong className="account-row-balance">{money(account.balance, account.currency)}</strong>
    </div>
  )
}

function TransferPage({ accounts, form, setForm, saving, onSubmit }) {
  const selectedAccount = accounts.find((account) => account.id === form.fromAccountId)
  return (
    <>
      <PageHeading eyebrow="MOVE MONEY WITH CONFIDENCE" title="Make a transfer" description="Send funds securely between active BalanceVault accounts." />
      <div className="transfer-layout">
        <form className="panel transfer-form" onSubmit={onSubmit}>
          <div className="transfer-form-heading"><span className="transfer-form-icon">⇄</span><div><h2>Transfer details</h2><p>Transfers are recorded immediately in your ledger.</p></div></div>
          {!accounts.length ? (
            <div className="inline-notice"><span>i</span><p>You need an active account before you can send money. New accounts require administrator activation.</p></div>
          ) : (
            <>
              <label>
                From account
                <select
                  onChange={(event) => setForm({ ...form, fromAccountId: event.target.value })}
                  required
                  value={form.fromAccountId}
                >
                  <option value="">Choose an active account</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.accountNumber} · {money(account.balance, account.currency)}</option>)}
                </select>
              </label>
              <label>
                Recipient account number
                <input
                  autoComplete="off"
                  onChange={(event) => setForm({ ...form, toAccountNumber: event.target.value })}
                  placeholder="BV000000000000"
                  required
                  value={form.toAccountNumber}
                />
              </label>
              <div className="form-columns">
                <label>
                  Amount
                  <div className="amount-input"><span>₹</span><input
                    inputMode="decimal"
                    onChange={(event) => setForm({ ...form, amount: event.target.value })}
                    placeholder="0.00"
                    required
                    type="text"
                    value={form.amount}
                  /></div>
                </label>
                <label>
                  Currency
                  <input disabled value={selectedAccount?.currency || 'INR'} />
                </label>
              </div>
              <label>
                Note <span className="optional-label">OPTIONAL</span>
                <input
                  maxLength="140"
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  placeholder="What’s this transfer for?"
                  value={form.description}
                />
              </label>
              {selectedAccount && <div className="available-note"><span>✓</span> Available balance: <strong>{money(selectedAccount.balance, selectedAccount.currency)}</strong></div>}
              <button className="button button-primary transfer-submit" disabled={saving || !accounts.length} type="submit">
                {saving ? <><span className="spinner spinner-light" /> Processing securely…</> : <>Review &amp; transfer <span>→</span></>}
              </button>
              <p className="transfer-disclaimer">By continuing, you authorize this transfer. Completed transfers cannot be edited.</p>
            </>
          )}
        </form>
        <aside className="transfer-aside">
          <div className="transfer-aside-card">
            <div className="aside-icon">⌑</div>
            <h3>Built for peace of mind</h3>
            <p>Every transfer is checked, recorded, and protected against accidental duplicate requests.</p>
            <div className="aside-check"><span>✓</span> Secure session</div>
            <div className="aside-check"><span>✓</span> Double-entry ledger</div>
            <div className="aside-check"><span>✓</span> Transfer receipt</div>
          </div>
          <div className="aside-help"><span>Need a hand?</span><p>Double-check the recipient’s account number before sending.</p></div>
        </aside>
      </div>
    </>
  )
}

function ActivityPage({ transfers, accounts, isAdmin }) {
  const ownAccountIds = new Set(accounts.map((account) => account.id))
  return (
    <>
      <PageHeading eyebrow={isAdmin ? 'SYSTEM TRANSACTION HISTORY' : 'YOUR TRANSACTION HISTORY'} title="Activity" description="A clear, permanent record of money in and out." />
      <div className="panel activity-table-panel">
        <div className="panel-heading"><div><h2>All transactions</h2><p>{transfers.length} recent {transfers.length === 1 ? 'transaction' : 'transactions'}</p></div><span className="table-privacy">⌑ {isAdmin ? 'Administrator view' : 'Private to your accounts'}</span></div>
        {transfers.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>TRANSACTION</th><th>DATE</th><th>ACCOUNT</th><th>STATUS</th><th className="amount-column">AMOUNT</th></tr></thead>
              <tbody>{transfers.map((transfer) => {
                const outgoing = !isAdmin && ownAccountIds.has(transfer.fromAccountId)
                return (
                  <tr key={transfer.id}>
                    <td><span className={`transaction-kind ${isAdmin ? 'kind-neutral' : outgoing ? 'kind-out' : 'kind-in'}`}>{isAdmin ? '↔' : outgoing ? '↑' : '↓'}</span><span className="transaction-title"><strong>{transfer.description || (isAdmin ? 'Account transfer' : outgoing ? 'Transfer sent' : 'Transfer received')}</strong><small>Ref. {transfer.id.slice(0, 8).toUpperCase()}</small></span></td>
                    <td>{dateLabel(transfer.createdAt)}</td>
                    <td className="account-number-cell">{outgoing ? transfer.fromAccount?.accountNumber : transfer.toAccount?.accountNumber}</td>
                    <td><StatusBadge status={transfer.status} /></td>
                    <td className={`amount-column ${isAdmin ? '' : outgoing ? 'amount-negative' : 'amount-positive'}`}>{isAdmin ? '' : outgoing ? '−' : '+'}{money(transfer.amount, transfer.currency)}</td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        ) : <EmptyState title="Your activity will appear here" text="Once you complete a transfer, you’ll find a permanent record on this page." />}
      </div>
    </>
  )
}

function ProfilePage({ user, onSignOut, saving }) {
  return (
    <>
      <PageHeading eyebrow="YOUR ACCOUNT" title="Profile & settings" description="Manage your profile and session security." />
      <div className="profile-layout">
        <section className="panel profile-card">
          <div className="profile-card-top"><div className="avatar avatar-large">{initials(user.name)}</div><div><h2>{user.name}</h2><p>{user.role === 'ADMIN' ? 'Administrator' : 'Account holder'}</p></div></div>
          <div className="profile-details">
            <div><span>FULL NAME</span><strong>{user.name}</strong></div>
            <div><span>EMAIL ADDRESS</span><strong>{user.email}</strong></div>
            <div><span>ACCOUNT TYPE</span><strong>{user.role === 'ADMIN' ? 'Administrator' : 'Personal account'}</strong></div>
            <div><span>ACCOUNT ID</span><strong className="mono">{user.id}</strong></div>
          </div>
          <div className="profile-readonly"><span>i</span><p>Profile changes are managed by your BalanceVault administrator. Contact support if your details need updating.</p></div>
        </section>
        <section className="panel settings-card">
          <div className="panel-heading"><div><h2>Security</h2><p>Keep your account protected.</p></div><span className="settings-shield">⌑</span></div>
          <div className="setting-item"><div><strong>Secure session</strong><span>Your sign-in is protected by an HttpOnly session cookie.</span></div><span className="settings-on">ON</span></div>
          <div className="setting-item"><div><strong>Account status</strong><span>{user.role === 'ADMIN' ? 'Administrator access is enabled.' : 'Your account is active.'}</span></div><span className="status-dot" /></div>
          <button className="button button-outline signout-button" disabled={saving} onClick={onSignOut} type="button">Sign out of BalanceVault <span>→</span></button>
        </section>
      </div>
    </>
  )
}

function AdminPage({ data, accounts, saving, onStatusChange }) {
  return (
    <>
      <PageHeading eyebrow="OPERATIONS & OVERSIGHT" title="Admin console" description="Review activity and keep customer accounts in good standing." />
      <div className="admin-stats">
        <StatCard label="Customers" value={data?.overview.userCount ?? '—'} icon="○" note="Registered users" />
        <StatCard label="Accounts" value={data?.overview.accountCount ?? '—'} icon="▤" note="Across all statuses" />
        <StatCard label="Completed transfers" value={data?.overview.completedTransferCount ?? '—'} icon="⇄" note="All-time total" positive />
        <StatCard
          label="Transfer volume"
          value={data ? Object.entries(data.overview.completedTransferVolumes || {}).map(([currency, amount]) => money(amount, currency)).join(' · ') || money(0) : '—'}
          icon="₹"
          note="Completed transactions"
        />
      </div>
      <section className="panel admin-accounts">
        <div className="panel-heading"><div><h2>Account oversight</h2><p>Activate or restrict accounts using the status controls.</p></div><span className="admin-tag">ADMIN ACCESS</span></div>
        {accounts.length ? (
          <div className="admin-account-list">
            {accounts.map((account) => (
              <div className="admin-account-row" key={account.id}>
                <div className="account-row-icon">₹</div>
                <div><strong>{account.accountNumber}</strong><span>{account.currency} · {money(account.balance, account.currency)}</span></div>
                <StatusBadge status={account.status} />
                {account.status !== 'CLOSED' && <select aria-label={`Change ${account.accountNumber} status`} disabled={saving} onChange={(event) => onStatusChange(account.id, event.target.value)} value={account.status}><option value="PENDING">Pending</option><option value="ACTIVE">Active</option><option value="FROZEN">Frozen</option><option value="CLOSED">Closed</option></select>}
              </div>
            ))}
          </div>
        ) : <EmptyState title="No customer accounts" text="Accounts created by customers will appear here." />}
      </section>
      <section className="content-grid admin-lower">
        <div className="panel">
          <div className="panel-heading"><div><h2>Recent customers</h2><p>Newest account holders</p></div></div>
          {data?.users?.length ? data.users.map((accountUser) => <div className="admin-user-row" key={accountUser.id}><span className="avatar">{initials(accountUser.name)}</span><div><strong>{accountUser.name}</strong><span>{accountUser.email}</span></div><UserStatusBadge active={accountUser.isActive} /></div>) : <EmptyState title="No customers yet" text="New registrations will show here." />}
        </div>
        <div className="panel">
          <div className="panel-heading"><div><h2>Latest audit events</h2><p>Recent recorded actions</p></div></div>
          {data?.auditLogs?.length ? data.auditLogs.map((log) => <div className="audit-row" key={log.id}><span className="audit-dot" /><div><strong>{log.action.replaceAll('_', ' ').toLowerCase()}</strong><span>{log.actor?.name || 'System'} · {dateLabel(log.createdAt)}</span></div></div>) : <EmptyState title="No audit events" text="Important account actions will be recorded here." />}
        </div>
      </section>
    </>
  )
}

function TransferRow({ transfer, accounts, isAdmin }) {
  const outgoing = accounts.some((account) => account.id === transfer.fromAccountId)
  return (
    <div className="activity-row">
      <span className={`transaction-kind ${isAdmin ? 'kind-neutral' : outgoing ? 'kind-out' : 'kind-in'}`}>{isAdmin ? '↔' : outgoing ? '↑' : '↓'}</span>
      <div className="activity-copy"><strong>{transfer.description || (isAdmin ? 'Account transfer' : outgoing ? 'Transfer sent' : 'Transfer received')}</strong><span>{dateLabel(transfer.createdAt)} · <StatusBadge status={transfer.status} /></span></div>
      <strong className={isAdmin ? '' : outgoing ? 'amount-negative' : 'amount-positive'}>{isAdmin ? '' : outgoing ? '−' : '+'}{money(transfer.amount, transfer.currency)}</strong>
    </div>
  )
}

function UserStatusBadge({ active }) {
  return <span className={`status-badge ${active ? 'status-active' : 'status-frozen'}`}><i />{active ? 'Enabled' : 'Disabled'}</span>
}

function StatusBadge({ status }) {
  const label = status.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())
  return <span className={`status-badge status-${status.toLowerCase()}`}><i />{label}</span>
}

function EmptyState({ title, text }) {
  return <div className="empty-state"><div className="empty-icon">⌑</div><strong>{title}</strong><p>{text}</p></div>
}

export default App
