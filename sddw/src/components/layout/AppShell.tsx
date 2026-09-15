import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { useState } from 'react';
import { usePrincipal, useServices } from '@/app/providers';
import { Badge } from '@/components/nebula';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '▦' },
  { to: '/specs', label: 'Catalogue', icon: '☰' },
  { to: '/reviews', label: 'Reviews', icon: '✓' },
  { to: '/certification', label: 'Certification', icon: '◈' },
  { to: '/delivery', label: 'Delivery', icon: '⇢' },
];

export function AppShell() {
  const principal = usePrincipal();
  const { config } = useServices();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">Skip to content</a>
      <nav aria-label="Primary" className="flex w-56 shrink-0 flex-col border-r border-surface-line bg-surface">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="grid h-8 w-8 place-items-center rounded-nebula bg-brand-700 font-bold text-white">S</span>
          <div><div className="text-sm font-semibold leading-tight">SDD Workbench</div><div className="text-[11px] text-ink-subtle">Spec Driven Development</div></div>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => clsx('flex items-center gap-3 rounded-nebula px-3 py-2 text-sm', isActive ? 'bg-brand-50 font-semibold text-brand-800' : 'text-ink-muted hover:bg-surface-alt hover:text-ink')}>
                <span aria-hidden className="w-4 text-center">{n.icon}</span>{n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="border-t border-surface-line px-4 py-3 text-xs text-ink-subtle">
          Storage: <Badge tone={config.storageProvider === 'mock' ? 'warning' : 'success'}>{config.storageProvider}</Badge>
          <div className="mt-1">AI: <Badge tone={config.companionBaseUrl ? 'success' : 'warning'}>{config.companionBaseUrl ? 'SDD Companion' : 'mock companion'}</Badge></div>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-surface-line bg-surface px-6 py-3">
          <form role="search" className="flex-1" onSubmit={(e) => { e.preventDefault(); nav(`/specs?q=${encodeURIComponent(q)}`); }}>
            <label htmlFor="global-search" className="sr-only">Search specifications</label>
            <input id="global-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search specifications, IDs, owners…" className="h-9 w-full max-w-xl rounded-nebula border border-surface-line bg-surface-alt px-3 text-sm" />
          </form>
          <Badge tone="neutral">internal</Badge>
          <div className="flex items-center gap-2 text-sm">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800" aria-hidden>{principal.user.displayName.split(' ').map((s) => s[0]).join('').slice(0, 2)}</span>
            <span>{principal.user.displayName}</span>
            <a href="/oauth2/sign_out" className="text-xs text-brand-700 hover:underline">Sign out</a>
          </div>
        </header>
        <main id="main" className="flex-1 p-6"><Outlet /></main>
      </div>
    </div>
  );
}
