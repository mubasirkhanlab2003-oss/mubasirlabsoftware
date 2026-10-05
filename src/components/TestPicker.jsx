// Choosing tests on the registration screen: type to search (code, name or
// other names like "sperm"), one-tap buttons for the lab's usual tests, and a
// "browse by department" list for everything else.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db.js';

const norm = (s) => String(s || '').toLowerCase().trim();

// Lower score = better match. null = no match.
export function matchScore(t, q) {
  if (!q) return null;
  const code = norm(t.code), name = norm(t.name), al = norm(t.aliases);
  if (code === q) return 0;
  if (code.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (name.split(/[\s(),/&-]+/).some((w) => w.startsWith(q))) return 3;
  if (name.includes(q)) return 4;
  if (al.split(/[,;]+/).some((a) => norm(a).startsWith(q))) return 5;
  if (al.includes(q)) return 6;
  if (code.includes(q)) return 7;
  return null;
}

export function searchTests(tests, query, limit = 12) {
  const q = norm(query);
  if (!q) return [];
  return tests.map((t) => [t, matchScore(t, q)]).filter(([, s]) => s !== null)
    .sort((a, b) => a[1] - b[1] || (a[0].kind === 'package' ? 1 : 0) - (b[0].kind === 'package' ? 1 : 0) || String(a[0].name).localeCompare(b[0].name))
    .slice(0, limit).map(([t]) => t);
}

// The tests this lab books most (last 30 days).
function useUsualTests(tests) {
  const counts = useLiveQuery(async () => {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const rows = await db().accession_tests.toArray();
    const out = {};
    for (const r of rows) {
      if (r.deleted_at || r.status === 'cancelled' || (r.created_at && r.created_at < since)) continue;
      out[r.test_id] = (out[r.test_id] || 0) + 1;
    }
    return out;
  }, [], {});
  return useMemo(() => tests.filter((t) => t.kind !== 'package' && counts?.[t.id])
    .sort((a, b) => counts[b.id] - counts[a.id]).slice(0, 12), [tests, counts]);
}

export default function TestPicker({ tests, sel, toggle, money, qRef }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [browse, setBrowse] = useState(false);
  const [openDept, setOpenDept] = useState({});
  const box = useRef(null);
  const results = useMemo(() => searchTests(tests, q), [tests, q]);
  const usual = useUsualTests(tests);
  const depts = useMemo(() => {
    const m = new Map();
    for (const t of tests) { const d = t.kind === 'package' ? 'Packages' : (t.category || 'General'); if (!m.has(d)) m.set(d, []); m.get(d).push(t); }
    return [...m.entries()].sort((a, b) => (a[0] === 'Packages' ? -1 : b[0] === 'Packages' ? 1 : a[0].localeCompare(b[0])));
  }, [tests]);

  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => { if (open && q.trim().length === 1) box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [open, q]);
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const price = (t) => (t.price == null ? <span className="nop">no price</span> : money(t.price));
  function pick(t) { toggle(t.id); }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, Math.max(results.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); }
    else if (e.key === 'Enter') { e.preventDefault(); const t = results[hi]; if (t) { if (!sel.includes(t.id)) pick(t); setQ(''); setOpen(false); } }
  }

  return (
    <div>
      <div className="tp-search" ref={box}>
        <input ref={qRef} value={q} role="combobox" aria-expanded={open && results.length > 0} aria-autocomplete="list"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey}
          placeholder="Type a test: CBC, sugar, thyroid, sperm…" autoComplete="off" />
        {open && q.trim() && (
          <div className="tp-list" role="listbox">
            {results.map((t, i) => {
              const on = sel.includes(t.id);
              return (
                <button type="button" key={t.id} role="option" aria-selected={on} className={`${i === hi ? 'hi' : ''} ${on ? 'on' : ''}`}
                  onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => { pick(t); }}>
                  <span className="tick">{on ? '✓' : ''}</span>
                  <span className="code">{t.code}</span>
                  <span className="nm">{t.name}{t.kind === 'package' && <em> package</em>}</span>
                  <span className="p">{price(t)}</span>
                </button>
              );
            })}
            {!results.length && <div className="empty" style={{ padding: 12 }}>No test matches “{q}”. Add it in Settings → Tests &amp; prices.</div>}
          </div>
        )}
      </div>

      <div className="tp-usual">
        <span className="faint">Usual tests</span>
        {usual.length ? usual.map((t) => (
          <button type="button" key={t.id} className={`chip ${sel.includes(t.id) ? 'on' : ''}`} onClick={() => pick(t)} title={t.name}>{t.code}</button>
        )) : <span className="faint">— the tests you book most will appear here after a few days</span>}
      </div>

      <button type="button" className="btn small" onClick={() => setBrowse(!browse)} aria-expanded={browse}>{browse ? 'Hide all tests ▴' : 'Browse all tests ▾'}</button>
      {browse && (
        <div className="tp-browse">
          {depts.map(([d, list]) => {
            const isOpen = !!openDept[d];
            const n = list.filter((t) => sel.includes(t.id)).length;
            return (
              <div key={d} className="tp-dept">
                <button type="button" className="tp-dept-head" aria-expanded={isOpen} onClick={() => setOpenDept({ ...openDept, [d]: !isOpen })}>
                  <span>{d}</span><span className="faint">{list.length}{n ? ` · ${n} chosen` : ''}</span><span className="chev">{isOpen ? '▴' : '▾'}</span>
                </button>
                {isOpen && (
                  <div className="test-pick">
                    {list.map((t) => (
                      <button type="button" key={t.id} className={sel.includes(t.id) ? 'on' : ''} onClick={() => pick(t)}>
                        <span className="code">{t.code}</span><span>{t.name}</span><span className="p">{price(t)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
