import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAuth } from '../lib/auth.jsx';
import { useSettings, useSync } from '../lib/hooks.js';
import { db, getMeta } from '../lib/db.js';
import { syncNow } from '../lib/sync.js';
import { fmtDateTime, todayISO, addDays } from '../lib/format.js';
import { roleLabel } from '../lib/perms.js';
import Icon from './icons.jsx';

const SYNC_TEXT = { online: 'Online', synced: 'All saved', syncing: 'Saving…', offline: 'Offline', error: 'Sync problem' };

export function SyncPill() {
  const s = useSync();
  const nav = useNavigate();
  let text = SYNC_TEXT[s.status] || s.status;
  if (s.pending && s.status !== 'error') text = `${s.pending} waiting`;
  return (
    <button className={`sync ${s.status}`} title={s.lastSync ? `Last saved to server ${fmtDateTime(s.lastSync)}${s.message ? '\n' + s.message : ''}` : s.message}
      onClick={() => (s.status === 'error' ? nav('/settings?tab=sync') : syncNow())}>
      <i /><span className="txt">{text}</span>
    </button>
  );
}

// Theme: follows the device unless the user picks one.
function useTheme() {
  const [t, setT] = useState(() => { try { return localStorage.getItem('lis_theme') || ''; } catch { return ''; } });
  useEffect(() => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    try { if (t) localStorage.setItem('lis_theme', t); else localStorage.removeItem('lis_theme'); } catch { /* ignore */ }
  }, [t]);
  const dark = t ? t === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return [dark, () => setT(dark ? 'light' : 'dark')];
}

// One box for everything: scan a barcode, type MR / phone / CNIC / name /
// case number. Enter opens the first match.
export function ScanBox() {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef(null);
  const s = q.trim().toLowerCase();
  const hits = useLiveQuery(async () => {
    if (s.length < 2) return [];
    const out = [];
    const up = q.trim().toUpperCase();
    const spec = await db().specimens.where('specimen_number').equals(up).first();
    if (spec) out.push({ kind: 'Sample', label: `${spec.specimen_number} · ${spec.sample_type}`, to: `/cases/${spec.accession_id}` });
    const acc = await db().accessions.where('acc_number').equals(up).first();
    if (acc) out.push({ kind: 'Case', label: acc.acc_number, to: `/cases/${acc.id}` });
    const d = s.replace(/\D/g, '');
    const pts = await db().patients.filter((p) => !p.deleted_at && (
      p.full_name.toLowerCase().includes(s) || (p.mr_number || '').toLowerCase() === s
      || (d.length >= 4 && (String(p.phone || '').replace(/\D/g, '').includes(d) || String(p.cnic || '').replace(/\D/g, '').includes(d))))).limit(8).toArray();
    for (const p of pts) out.push({ kind: 'Patient', label: `${p.full_name} · ${p.mr_number}${p.phone ? ' · ' + p.phone : ''}`, to: `/patients/${p.id}` });
    return out;
  }, [s], []);
  useEffect(() => {
    const k = (e) => { if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !/input|textarea|select/i.test(document.activeElement?.tagName)) { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const go = (h) => { if (!h) return; nav(h.to); setQ(''); setOpen(false); ref.current?.blur(); };
  return (
    <div className="scan">
      <Icon name="search" />
      <input ref={ref} value={q} placeholder="Scan barcode, or search name, MR, phone, CNIC, case no.  ( / )"
        onChange={(e) => { setQ(e.target.value); setHi(0); setOpen(true); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); go(hits[hi]); }
          if (e.key === 'Escape') { setQ(''); ref.current?.blur(); }
        }} aria-label="Search" />
      {open && s.length >= 2 && (
        <div className="scan-list">
          {hits.map((h, i) => (
            <button key={h.to + h.label} className={i === hi ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
              <span className="kind">{h.kind}</span><span>{h.label}</span>
            </button>
          ))}
          {!hits.length && <div className="empty" style={{ padding: 14 }}>Nothing found. <a href="/register" onMouseDown={(e) => { e.preventDefault(); nav('/register'); }}>Register a new patient</a></div>}
        </div>
      )}
    </div>
  );
}

function SetupBanner() {
  const settings = useSettings();
  const info = useLiveQuery(async () => ({
    priced: await db().lab_tests.filter((t) => t.active !== false && t.price != null).count(),
    path: await db().pathologists.filter((p) => p.active !== false).count(),
    lastBackup: await getMeta('last_backup'),
  }), [], null);
  if (!settings || !info) return null;
  const todo = [
    !settings.lab_name && ['Enter the lab name, address and phone', '/settings?tab=lab'],
    !info.priced && ['Enter prices for the tests you do (no prices are pre-filled)', '/settings?tab=tests'],
    !info.path && ['Add the pathologist (name, qualification, signature) for reports', '/settings?tab=pathologists'],
    !settings.public_url && ['Enter the web address of this app (used in QR codes and WhatsApp links)', '/settings?tab=lab'],
  ].filter(Boolean);
  const days = Number(settings.backup_reminder_days || 7);
  const backupOld = settings.lab_name && (!info.lastBackup || info.lastBackup < addDays(todayISO(), -days));
  if (!todo.length && !backupOld) return null;
  return (
    <div className="setup-banner no-print">
      {todo.length > 0 && <><b>Finish setting up</b>
        <ul>{todo.map(([t, to]) => <li key={t}><NavLink to={to}>{t}</NavLink></li>)}</ul></>}
      {backupOld && <div>No backup downloaded in the last {days} days. <NavLink to="/settings?tab=backup">Download a backup now</NavLink></div>}
    </div>
  );
}

export default function Layout() {
  const { isAdmin, can, profile, user, signOut, role } = useAuth();
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const sync = useSync();
  const [dark, toggleTheme] = useTheme();
  const today = todayISO();
  const counts = useLiveQuery(async () => {
    const open = await db().accession_tests.where('status').anyOf(['pending', 'collected', 'entered']).toArray();
    const accs = new Map((await db().accessions.bulkGet([...new Set(open.map((t) => t.accession_id))])).filter(Boolean).map((a) => [a.id, a]));
    const live = open.filter((t) => accs.get(t.accession_id) && !accs.get(t.accession_id).deleted_at);
    const home = (await db().accessions.where('reg_date').between(addDays(today, -1), addDays(today, 7), true, true).toArray())
      .filter((a) => a.home_collection && a.home_status === 'scheduled' && !a.deleted_at).length;
    return { work: live.filter((t) => t.status !== 'pending').length, verify: live.filter((t) => t.status === 'entered').length, home };
  }, [today], { work: 0, verify: 0, home: 0 });

  const groups = [
    [null, [
      ['/', 'Today', 'today', null, 'today'],
      ['/register', 'New patient / test', 'plus', null, 'register'],
      ['/patients', 'Patients', 'users', null, 'patients'],
      ['/worklist', 'Worklist & results', 'flask', counts.work, 'worklist'],
      ['/home-collection', 'Home collection', 'home', counts.home, 'home'],
    ]],
    ['Money', [
      ['/billing', 'Bills & cash', 'bill', null, 'payments'],
      ['/doctors', 'Doctors & commission', 'doctor', null, 'doctors_view'],
      ['/panels', 'Panels / companies', 'building', null, 'panels'],
      ['/expenses', 'Expenses', 'wallet', null, 'expenses'],
      ['/reports', 'Reports', 'chart', null, 'reports'],
    ]],
    ['Lab quality', [
      ['/stock', 'Stock & reagents', 'box', null, 'stock'],
      ['/qc', 'Quality control', 'qc', null, 'qc'],
      ['/equipment', 'Equipment', 'tool', null, 'equipment'],
      ['/outsource', 'Outsourced tests', 'truck', null, 'outsource'],
    ]],
    ['System', [
      ['/settings', 'Settings', 'gear', null, 'settings'],
      ['/recycle', 'Recycle bin', 'trash', null, 'settings'],
    ]],
  ];

  return (
    <div className="shell">
      <aside className={`side ${open ? 'open' : ''}`}>
        <div className="brand">
          {settings?.logo ? <img src={settings.logo} alt="" /> : <span className="brand-mark"><i /></span>}
          <div><b>{settings?.lab_name || 'Laboratory'}</b><small>{roleLabel(role)}</small></div>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {groups.map(([g, links]) => {
            const shown = links.filter((l) => isAdmin || can(l[4]));
            if (!shown.length) return null;
            return (
              <div key={g || 'main'} style={{ display: 'contents' }}>
                {g && <div className="group">{g}</div>}
                {shown.map(([to, label, icon, count]) => (
                  <NavLink key={to} to={to} end={to === '/'}>
                    <Icon name={icon} />{label}{count ? <span className="count">{count}</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <div className="who">{profile?.full_name || user?.email}</div>
          <div className="row">
            <button onClick={toggleTheme} title="Light / dark"><Icon name="moon" size={14} /> {dark ? 'Light' : 'Dark'}</button>
            <button onClick={() => signOut()}>Sign out</button>
          </div>
        </div>
      </aside>
      {open && <button className="side-backdrop no-print" aria-label="Close menu" onClick={() => setOpen(false)} />}
      <div className="main">
        <div className="topbar no-print">
          <button className="btn small menu-btn" onClick={() => setOpen(!open)} aria-label="Menu"><Icon name="menu" /></button>
          <ScanBox />
          <div className="grow" />
          {counts.verify > 0 && (isAdmin || can('verify')) && <NavLink className="badge violet" to="/worklist?status=entered">{counts.verify} to verify</NavLink>}
          <SyncPill />
        </div>
        {sync.status === 'offline' && <div className="offline-banner no-print">No internet. Keep working — everything is saved on this device and is sent automatically when the internet is back.</div>}
        <div className="content">{isAdmin && <SetupBanner />}<Outlet /></div>
      </div>
    </div>
  );
}
