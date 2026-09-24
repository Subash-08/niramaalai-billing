'use client';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {useEffect, useRef, useState, ReactNode} from 'react';
import {
  Monitor,
  LayoutDashboard,
  Users,
  MessageSquareText,
  ShoppingCart,
  FileText,
  Wrench,
  Package,
  Truck,
  CalendarClock,
  Wallet,
  ArrowLeftRight,
  ShieldCheck,
  BarChart3,
  Settings,
  Bell,
  Search,
  ChevronDown,
  Menu,
  X,
  LogOut,
  Building2,
  UserRound,
} from 'lucide-react';
import {useStore} from './store';
import {money} from '@/lib/domain';

const groups = [
  {
    label: 'OVERVIEW',
    items: [['/', 'Dashboard', LayoutDashboard]],
  },
  {
    label: 'BILLING',
    items: [
      ['/customers', 'Customers', Users],
      ['/sales', 'Sales & invoices', ShoppingCart],
      ['/payments', 'Payments & receipts', Wallet],
      ['/templates', 'Invoice templates', FileText],
      ['/print-jobs', 'Print jobs', CalendarClock],
    ],
  },
  {
    label: 'CATALOGUE',
    items: [
      ['/inventory', 'Products', Package],
      ['/service-catalog', 'Services', Wrench],
    ],
  },
  {
    label: 'BUSINESS',
    items: [
      ['/reports', 'Reports', BarChart3],
      ['/settings', 'Settings', Settings],
      ['/account', 'Company account', Users],
    ],
  },
];

type ModuleMode = 'live' | 'mixed' | 'preview';
const previewPaths = new Set<string>([]);
const mixedPaths = new Set<string>([]);

function moduleMode(url: string): ModuleMode {
  if (previewPaths.has(url)) return 'preview';
  if (mixedPaths.has(url)) return 'mixed';
  return 'live';
}

function currentModuleMode(path: string): ModuleMode {
  const root = `/${path.split('/').filter(Boolean)[0] || ''}`;
  return moduleMode(root);
}

export default function Shell({children}: {children: ReactNode}) {
  const path = usePathname();
  const router = useRouter();
  const {state, isLive, isLoading, companySession, refreshMasterData, notify} = useStore();
  const [mobile, setMobile] = useState(false);
  const [query, setQuery] = useState('');
  const [notifications, setNotifications] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeMenus(event: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setAccountOpen(false);
        setNotifications(false);
      }
    }
    document.addEventListener('mousedown', closeMenus);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenus);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const userName = isLive ? companySession?.user?.name || 'Company user' : 'Guest';
  const userEmail = isLive ? companySession?.user?.email || '' : '';
  const companyName = isLive ? companySession?.company?.name || state.settings.name || 'Company' : 'Billing Software';
  const initials = userName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch('/api/auth/logout', {method: 'POST'});
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Sign out failed.');
      }
      setAccountOpen(false);
      await refreshMasterData();
      notify('Signed out.');
      router.push('/account');
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Sign out failed. Try again.');
    } finally {
      setSigningOut(false);
    }
  }

  const queryLower = query.toLowerCase();
  const customers = query
    ? state.customers.filter((c: any) => (c.name + ' ' + c.phone + ' ' + (c.gst || '')).toLowerCase().includes(queryLower)).slice(0, 3)
    : [];
  const products = query
    ? state.products.filter((p: any) => (p.name + ' ' + (p.category || '') + ' ' + (p.description || '')).toLowerCase().includes(queryLower)).slice(0, 3)
    : [];
  const services = query
    ? ((state as any).services || []).filter((s: any) => (s.name + ' ' + (s.category || '')).toLowerCase().includes(queryLower)).slice(0, 3)
    : [];
  const invoices = query
    ? (state.bills || []).filter((b: any) => (b.id + ' ' + (b.customerSnapshot?.name || '')).toLowerCase().includes(queryLower)).slice(0, 3)
    : [];

  const pageMode = isLive ? currentModuleMode(path) : null;

  return (
    <div className="app">
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <Link href="/" className="brand">
          <div className="brand-icon">
            <Monitor size={24} />
          </div>
          <div>
            <strong>{isLive && state.settings.name ? state.settings.name : 'Billing Software'}</strong>
            <small>PRINT BUSINESS MANAGER</small>
          </div>
        </Link>
        <button className="mobile-close icon-btn" onClick={() => setMobile(false)} aria-label="Close navigation">
          <X />
        </button>
        <nav>
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-label">{g.label}</div>
              {g.items.map(([url, label, Icon]) => {
                const I = Icon as typeof Monitor;
                return (
                  <Link
                    onClick={() => setMobile(false)}
                    className={`nav-link ${(url === '/' ? path === '/' : path.startsWith(url as string)) ? 'active' : ''}`}
                    href={url as string}
                    key={url as string}
                  >
                    <I size={18} />
                     <span>{label as string}</span>
                    <em className={`module-badge ${moduleMode(url as string)}`}>
                      {moduleMode(url as string) === 'mixed' ? 'Partly live' : moduleMode(url as string) === 'live' ? 'Live' : 'Preview'}
                    </em>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="store-location">
            <span className="online-dot" />
            Company workspace
          </div>
          <small>Tenant-isolated billing records</small>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <button className="icon-btn mobile-toggle" onClick={() => setMobile(true)} aria-label="Open navigation">
            <Menu />
          </button>
          <div className="global-search">
            <Search size={18} />
            <input
              aria-label="Search customers or products"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search customers, products…"
            />
            <kbd>Search</kbd>
            {query && (
              <div className="search-results">
                {customers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      router.push('/customers/' + c.id);
                      setQuery('');
                    }}
                  >
                    <Users size={16} />
                    <div>
                      {c.name}
                      <small>{c.phone}</small>
                    </div>
                  </button>
                ))}
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      router.push('/inventory/' + p.id);
                      setQuery('');
                    }}
                  >
                    <Package size={16} />
                    <div>
                      {p.name}
                      <small>{p.category || 'Product'}</small>
                    </div>
                  </button>
                ))}
                {services.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      router.push('/service-catalog');
                      setQuery('');
                    }}
                  >
                    <Wrench size={16} />
                    <div>
                      {s.name}
                      <small>{s.category || 'Service'}</small>
                    </div>
                  </button>
                ))}
                {invoices.map((inv: any) => (
                  <button
                    key={inv.id}
                    onClick={() => {
                      router.push('/sales/' + inv.id);
                      setQuery('');
                    }}
                  >
                    <FileText size={16} />
                    <div>
                      {inv.id}
                      <small>{inv.date} · Due: {money(inv.due || 0)}</small>
                    </div>
                  </button>
                ))}
                {!customers.length && !products.length && !services.length && !invoices.length && <p>No matches found.</p>}
              </div>
            )}
          </div>
          {isLoading ? (
            <span className="session-pill loading">Checking account…</span>
          ) : isLive ? (
            <span className="live-pill" title="Connected to multi-tenant live company account">
              Live data · {companyName}
            </span>
          ) : (
            <span className="demo-pill">Sign in required</span>
          )}
          <div className="notification-wrap">
            <button
              className="icon-btn notification-button"
              aria-label="Notifications"
              onClick={() => setNotifications(!notifications)}
            >
              <Bell size={20} />
              <i />
            </button>
            {notifications && (
              <div className="notification-panel">
                <strong>Needs your attention</strong>
                <Link href="/payments" onClick={() => setNotifications(false)}>
                  Review payments and outstanding receipts
                </Link>
                <Link href="/print-jobs" onClick={() => setNotifications(false)}>
                  Review print jobs and delivery dates
                </Link>
                <Link href="/sales" onClick={() => setNotifications(false)}>
                  Review unpaid customer invoices
                </Link>
              </div>
            )}
          </div>
          <div className="account-menu-wrap" ref={accountRef}>
            <button
              className="user-menu"
              type="button"
              aria-label="Open account menu"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <div className="avatar">{initials}</div>
              <div>
                <strong>{userName}</strong>
                <span>{isLive ? companyName : 'Company access'}</span>
              </div>
              <ChevronDown size={15} />
            </button>
            {accountOpen && (
              <div className="account-menu-panel" role="menu">
                <div className="account-menu-identity">
                  <div className="avatar">{initials}</div>
                  <div>
                    <strong>{userName}</strong>
                    <small>{userEmail || 'Sign in to continue'}</small>
                  </div>
                </div>
                <div className={`account-data-status ${isLive ? 'live' : 'demo'}`}>
                  <span className="online-dot" />
                  <div>
                    <strong>{isLive ? 'Live company data' : 'Sign in required'}</strong>
                    <small>{isLive ? companyName : 'No billing data is loaded'}</small>
                  </div>
                </div>
                <Link href="/account" role="menuitem" onClick={() => setAccountOpen(false)}>
                  <UserRound size={16} /> Company account
                </Link>
                {isLive && (
                  <Link href="/settings" role="menuitem" onClick={() => setAccountOpen(false)}>
                    <Building2 size={16} /> Company settings
                  </Link>
                )}
                {isLive ? (
                  <button type="button" role="menuitem" onClick={signOut} disabled={signingOut}>
                    <LogOut size={16} /> {signingOut ? 'Signing out…' : 'Sign out'}
                  </button>
                ) : (
                  <Link href="/account" className="account-sign-in" role="menuitem" onClick={() => setAccountOpen(false)}>
                    Sign in to live data
                  </Link>
                )}
              </div>
            )}
          </div>
        </header>

        <main className={pageMode === 'preview' ? 'preview-live-view' : pageMode === 'mixed' ? 'mixed-live-view' : ''}>
          {!isLive && !isLoading && (
            <div className="module-migration-notice preview" role="status" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem'}}>
              <div>
                <strong>Company sign-in required:</strong> Sign in to access live tenant-isolated billing records.
              </div>
              <button
                type="button"
                className="btn"
                style={{padding: '0.35rem 0.85rem', fontSize: '0.82rem', whiteSpace: 'nowrap'}}
                onClick={() => router.push('/account')}
              >
                Sign in / register
              </button>
            </div>
          )}
          {pageMode === 'preview' && (
            <div className="module-migration-notice preview" role="status">
              <strong>Preview data:</strong> This workflow currently uses sample browser data. It is not read from or saved to your
              company database; live persistence is added in the transaction phases.
            </div>
          )}
          {pageMode === 'mixed' && (
            <div className="module-migration-notice mixed" role="status">
              <strong>Partly live:</strong> Connected actions save to your company account. Some related workflows are still
              incomplete or under review. A saved record does not mean every linked payment, report or preview is complete.
            </div>
          )}
          {pageMode === 'live' && (
            <div className="module-migration-notice live" role="status">
              <strong>Live data:</strong> Changes on this page are saved to the current company account.
            </div>
          )}
          {children}
        </main>

        <footer className="app-footer">
          <span>{isLive ? companySession?.company?.name || state.settings.name || 'Billing Software' : 'Billing Software'}</span>
          <span>{isLive ? `${pageMode === 'preview' ? 'Preview' : pageMode === 'mixed' ? 'Partly live' : 'Live'} module · Multi-tenant account` : 'Secure company access'}</span>
        </footer>
      </div>
    </div>
  );
}
