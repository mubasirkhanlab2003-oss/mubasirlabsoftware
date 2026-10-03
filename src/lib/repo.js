import { db, getMeta, setMeta } from './db.js';
import { requestSync } from './sync.js';

export const uuid = () => crypto.randomUUID();

// Run several local writes atomically (all-or-nothing on this device).
export function tx(tables, fn) {
  const d = db();
  return d.transaction('rw', [d.meta, ...tables.map((t) => d[t])], fn);
}

// Human-readable numbers: PREFIX + device code + sequence, e.g. INV2-00017.
// The device code comes from the server, so offline devices never collide.
export async function nextNumber(prefix) {
  const code = await getMeta('device_code');
  if (!code) {
    throw new Error('This device has not been registered yet. Connect to the internet once, then try again.');
  }
  return db().transaction('rw', db().meta, async () => {
    const key = 'ctr_' + prefix;
    const n = (await getMeta(key, 0)) + 1;
    await setMeta(key, n);
    return `${prefix}${code}-${String(n).padStart(5, '0')}`;
  });
}

export async function insertRow(table, data) {
  const row = {
    id: data.id || uuid(),
    created_at: new Date().toISOString(),
    ...data,
    _dirty: 1, _rev: 1, _base: null, _error: null,
  };
  await db()[table].add(row);
  requestSync();
  return row;
}

export async function updateRow(table, id, patch) {
  let out;
  await db().transaction('rw', db()[table], async () => {
    const cur = await db()[table].get(id);
    if (!cur) throw new Error('Record not found');
    out = { ...cur, ...patch, _dirty: 1, _rev: (cur._rev || 0) + 1, _error: null, _errorRev: null };
    await db()[table].put(out);
  });
  requestSync();
  return out;
}

// Strip device-only fields (for display, printing, exports)
export function clean(row) {
  if (!row) return row;
  const o = {};
  for (const k of Object.keys(row)) if (!k.startsWith('_')) o[k] = row[k];
  return o;
}
