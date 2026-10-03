import { db, TABLES, SERVER_FIELDS, getMeta, setMeta } from './db.js';

// ---------------------------------------------------------------------------
// Offline-first sync
//  * Every change is written to the local IndexedDB first (works offline).
//  * push: new rows are inserted; changed rows are updated only if the server
//    row_version is still the version this device last saw.
//  * If another device changed the same record meanwhile, changes to
//    different fields are merged automatically. If the SAME field was changed
//    on both, the server value is kept and this device's version is saved in
//    sync_conflicts for the Admin to review — nothing is silently lost.
//  * pull: rows changed on the server since the last pull are downloaded;
//    rows with unsent local edits are never overwritten.
// ---------------------------------------------------------------------------

let client = null;
let running = false;
let again = false;
let debounce = null;
let poller = null;
let deviceReady = false;
const listeners = new Set();

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

let state = { status: isOnline() ? 'online' : 'offline', pending: 0, errors: 0, lastSync: null, message: '' };

export function getSyncState() { return state; }
export function subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }
function setState(p) { state = { ...state, ...p }; listeners.forEach((f) => f(state)); }

class NetworkError extends Error {}

function assertNotNetwork(error) {
  if (!error) return;
  const msg = String(error.message || error);
  if (!error.code && /fetch|network|load failed|timeout/i.test(msg)) throw new NetworkError(msg);
}

export function initSync(supabaseClient, { pollMs = 15000 } = {}) {
  client = supabaseClient;
  deviceReady = false;
  if (typeof window !== 'undefined' && !poller) {
    window.addEventListener('online', () => syncNow());
    window.addEventListener('offline', () => setState({ status: 'offline' }));
    poller = setInterval(() => { if (document.visibilityState !== 'hidden') syncNow(); }, pollMs);
  }
}

export function stopSync() {
  client = null;
  deviceReady = false;
}

export function requestSync(delay = 800) {
  if (!client) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => syncNow(), delay);
}

export async function syncNow() {
  if (!client) return;
  if (running) { again = true; return; }
  if (!isOnline()) { setState({ status: 'offline' }); await countPending(); return; }
  running = true;
  setState({ status: 'syncing' });
  try {
    const { data } = await client.auth.getSession();
    if (!data?.session) {
      setState({ status: 'error', message: 'Sign in again to sync your changes' });
      return;
    }
    await ensureDevice();
    await pushAll();
    await pullAll();
    const { errors } = await countPending();
    setState({
      status: errors ? 'error' : 'synced',
      lastSync: new Date().toISOString(),
      message: errors ? `${errors} change(s) could not be synced` : '',
    });
  } catch (e) {
    if (e instanceof NetworkError || !isOnline()) setState({ status: 'offline', message: '' });
    else setState({ status: 'error', message: e.message || String(e) });
    await countPending().catch(() => {});
  } finally {
    running = false;
    if (again) { again = false; requestSync(200); }
  }
}

// ---------------- device registration (for offline-safe numbering) ----------
export async function ensureDevice() {
  if (deviceReady) return;
  let id = await getMeta('device_id');
  if (!id) { id = crypto.randomUUID(); await setMeta('device_id', id); }
  const label = typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 120) : 'device';
  const { data: code, error } = await client.rpc('register_device', { p_id: id, p_label: label });
  assertNotNetwork(error);
  if (error) throw new Error(error.message);
  await setMeta('device_code', code);
  const { data: max, error: e2 } = await client.rpc('device_max_numbers', { p_code: code });
  assertNotNetwork(e2);
  if (!e2 && max) {
    for (const [prefix, n] of Object.entries(max)) {
      const local = await getMeta('ctr_' + prefix, 0);
      if (n > local) await setMeta('ctr_' + prefix, n);
    }
  }
  deviceReady = true;
}

// ---------------- helpers ----------------------------------------------------
export function strip(row) {
  const o = {};
  if (!row) return o;
  for (const k of Object.keys(row)) {
    if (k.startsWith('_') || SERVER_FIELDS.includes(k)) continue;
    o[k] = row[k];
  }
  return o;
}

const DATE_RE = /^\d{4}-\d\d-\d\dT/;
const TIME_RE = /^\d\d:\d\d(:\d\d)?$/;

export function same(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && typeof a !== 'boolean') return na === nb;
  if (typeof a === 'string' && typeof b === 'string') {
    if (DATE_RE.test(a) && DATE_RE.test(b)) return new Date(a).getTime() === new Date(b).getTime();
    if (TIME_RE.test(a) && TIME_RE.test(b)) return a.slice(0, 5) === b.slice(0, 5);
  }
  return false;
}

export function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => k !== 'id' && k !== 'created_at' && !same(a[k], b[k]));
}

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === '' ? null : o[k]]));

function friendly(error) {
  const m = String(error?.message || error || 'Unknown error');
  if (m.includes('acc_tests_no_dup')) return 'This test is already on this bill (added on another device).';
  if (m.includes('more than the amount due')) return 'Payment is more than the amount due on this bill (another device may have taken a payment).';
  if (m.includes('verified and locked')) return 'This result was verified on another device. Use "Amend" to correct it.';
  if (m.includes('row-level security')) return 'Your account is not allowed to make this change.';
  return m;
}

async function fetchOne(table, id) {
  const { data, error } = await client.from(table).select('*').eq('id', id).maybeSingle();
  assertNotNetwork(error);
  return data || null;
}

// ---------------- push -------------------------------------------------------
async function pushAll() {
  for (const table of TABLES) {
    const rows = await db()[table].where('_dirty').equals(1).toArray();
    for (const row of rows) {
      if (row._error && row._errorRev === row._rev) continue; // waiting for user decision
      await pushRow(table, row);
    }
  }
}

async function pushRow(table, row) {
  const payload = Object.fromEntries(Object.entries(strip(row)).map(([k, v]) => [k, v === '' ? null : v]));
  if (!row._base) {
    const { data, error } = await client.from(table).insert(payload).select().maybeSingle();
    assertNotNetwork(error);
    if (!error && data) return markClean(table, row, data);
    if (error && error.code === '23505' && /_pkey/.test(error.message)) {
      // Already inserted earlier (response was lost). Continue as an update.
      const server = await fetchOne(table, row.id);
      if (server) return reconcile(table, row, server, server);
    }
    return markFailed(table, row, error);
  }
  const changed = diffKeys(payload, strip(row._base));
  if (!changed.length) return markClean(table, row, row._base);
  const { data, error } = await client.from(table).update(pick(payload, changed))
    .eq('id', row.id).eq('row_version', row._base.row_version).select();
  assertNotNetwork(error);
  if (error) return markFailed(table, row, error);
  if (data && data.length) return markClean(table, row, data[0]);
  const server = await fetchOne(table, row.id);
  if (!server) return markFailed(table, row, { message: 'Record not found on the server, or access denied.' });
  if (server.row_version === row._base.row_version) {
    return markFailed(table, row, { message: 'Your account is not allowed to make this change.' });
  }
  return reconcile(table, row, server, row._base);
}

async function reconcile(table, row, server, base) {
  const local = strip(row), srv = strip(server), b = strip(base);
  const localChanged = diffKeys(local, b);
  const serverChanged = new Set(diffKeys(srv, b));
  const toApply = localChanged.filter((k) => !same(local[k], srv[k]));
  const clash = toApply.filter((k) => serverChanged.has(k));
  const safe = toApply.filter((k) => !serverChanged.has(k));
  let latest = server;

  if (safe.length) {
    const { data, error } = await client.from(table).update(pick(local, safe))
      .eq('id', row.id).eq('row_version', server.row_version).select();
    assertNotNetwork(error);
    if (error) return markFailed(table, row, error);
    if (!data || !data.length) return; // changed again meanwhile; retry on next sync
    latest = data[0];
  }
  if (clash.length) {
    await reportConflict(table, row, srv, `Changed on another device at the same time: ${clash.join(', ')}. The other device's values were kept; this device's version is saved here.`);
    setState({ message: 'A record was changed on two devices. Admin can review it in Settings → Sync.' });
  }
  return markClean(table, row, latest);
}

async function markClean(table, row, server) {
  await db().transaction('rw', db()[table], async () => {
    const cur = await db()[table].get(row.id);
    if (cur && cur._rev !== row._rev) {
      // edited again while we were sending: keep the newer local edit
      await db()[table].put({ ...cur, row_version: server.row_version, _base: server, _error: null, _errorRev: null });
    } else {
      await db()[table].put({ ...server, _dirty: 0, _rev: cur?._rev ?? row._rev, _base: server, _error: null, _errorRev: null });
    }
  });
}

async function markFailed(table, row, error) {
  // A missing parent (foreign key) usually means the parent is still queued: retry later.
  if (error?.code === '23503') {
    await db()[table].update(row.id, { _error: 'Waiting for a related record to sync' });
    return;
  }
  const msg = friendly(error);
  await db()[table].update(row.id, { _error: msg, _errorRev: row._rev });
  await reportConflict(table, row, null, msg);
}

async function reportConflict(table, row, serverData, message) {
  try {
    const code = await getMeta('device_code');
    const { data: s } = await client.auth.getSession();
    await client.from('sync_conflicts').insert({
      table_name: table, record_id: row.id, local_data: strip(row), server_data: serverData,
      error: message, device_code: code, user_id: s?.session?.user?.id,
    });
  } catch { /* reporting is best effort; the local row keeps the error */ }
}

// ---------------- pull -------------------------------------------------------
const PAGE = 1000;

async function pullAll() {
  for (const table of TABLES) {
    const key = 'pulled_' + table;
    const since = await getMeta(key, '1970-01-01T00:00:00Z');
    // 2-minute overlap protects against transactions that committed late
    const from = new Date(new Date(since).getTime() - 120000).toISOString();
    let maxSeen = since;
    for (let page = 0; ; page++) {
      const { data, error } = await client.from(table).select('*').gt('updated_at', from)
        .order('updated_at').order('id').range(page * PAGE, page * PAGE + PAGE - 1);
      assertNotNetwork(error);
      if (error) break;
      await applyPulled(table, data || []);
      for (const r of data || []) if (r.updated_at > maxSeen) maxSeen = r.updated_at;
      if (!data || data.length < PAGE) break;
    }
    await setMeta(key, maxSeen);
  }
}

async function applyPulled(table, rows) {
  if (!rows.length) return;
  await db().transaction('rw', db()[table], async () => {
    const existing = await db()[table].bulkGet(rows.map((r) => r.id));
    const puts = [];
    rows.forEach((s, i) => {
      const cur = existing[i];
      if (!cur || !cur._dirty) puts.push({ ...s, _dirty: 0, _rev: cur?._rev || 0, _base: s, _error: null });
      // rows with unsent local edits are kept; push() detects any conflict
    });
    if (puts.length) await db()[table].bulkPut(puts);
  });
}

// ---------------- status -----------------------------------------------------
export async function countPending() {
  let pending = 0, errors = 0;
  for (const t of TABLES) {
    const rows = await db()[t].where('_dirty').equals(1).toArray();
    pending += rows.length;
    errors += rows.filter((r) => r._error && r._errorRev === r._rev).length;
  }
  setState({ pending, errors });
  return { pending, errors };
}

export async function listFailed() {
  const out = [];
  for (const t of TABLES) {
    const rows = await db()[t].where('_dirty').equals(1).toArray();
    rows.filter((r) => r._error).forEach((r) => out.push({ table: t, row: r }));
  }
  return out;
}

export async function retryFailed(table, id) {
  await db()[table].update(id, { _error: null, _errorRev: null });
  requestSync(0);
}

// Discard this device's unsent change: go back to the last synced version.
export async function discardLocal(table, id) {
  const row = await db()[table].get(id);
  if (!row) return;
  if (row._base) await db()[table].put({ ...row._base, _dirty: 0, _rev: (row._rev || 0) + 1, _base: row._base, _error: null });
  else await db()[table].delete(id);
  await countPending();
}
