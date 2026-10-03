import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db.js';
import { subscribe } from './sync.js';

const byOrder = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.name || a.full_name).localeCompare(String(b.name || b.full_name));

export const useSettings = () => useLiveQuery(() => db().lab_settings.get(1), [], undefined);
export const useTests = () => (useLiveQuery(() => db().lab_tests.toArray(), [], []) || []).sort(byOrder);
export const usePatient = (id) => useLiveQuery(() => (id ? db().patients.get(id) : undefined), [id]);
export const useDoctors = (all = false) => (useLiveQuery(() => db().ref_doctors.toArray(), [], []) || [])
  .filter((d) => all || (d.active !== false && !d.deleted_at)).sort((a, b) => a.full_name.localeCompare(b.full_name));
export const usePanels = (all = false) => (useLiveQuery(() => db().panels.toArray(), [], []) || [])
  .filter((p) => all || p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
export const usePathologists = () => (useLiveQuery(() => db().pathologists.toArray(), [], []) || [])
  .filter((p) => p.active !== false).sort(byOrder);
export const useMemberships = () => (useLiveQuery(() => db().memberships.toArray(), [], []) || []).filter((m) => m.active !== false);
export const useOutsourceLabs = () => (useLiveQuery(() => db().outsource_labs.toArray(), [], []) || []).filter((m) => m.active !== false);

export function useSync() {
  const [s, setS] = useState({ status: 'online', pending: 0, errors: 0 });
  useEffect(() => subscribe(setS), []);
  return s;
}

export function useDepartments() {
  const tests = useTests();
  return [...new Set(tests.filter((t) => t.kind !== 'package').map((t) => t.category || 'General'))].sort();
}

// Re-render every minute (for "overdue" timers).
export function useNow(ms = 60000) {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return n;
}
