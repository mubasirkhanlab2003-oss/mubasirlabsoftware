// Minimal in-memory imitation of the Supabase/PostgREST behaviour the sync
// engine relies on: server-set updated_at + row_version, primary-key and a
// few unique constraints, filtered updates, incremental selects.
export function createMockServer() {
  const tables = {};
  let clock = Date.parse('2026-09-18T08:00:00Z');
  const T = (n) => (tables[n] ||= new Map());
  const tick = () => new Date((clock += 1000)).toISOString();
  let deviceSeq = 0;
  const devices = new Map();
  let failNextInsertResponse = false;

  const uniqueChecks = {
    accession_tests: (r, all) => [...all.values()].some((v) => v.id !== r.id && v.accession_id === r.accession_id && v.test_id === r.test_id && v.status !== 'cancelled' && r.status !== 'cancelled')
      && 'duplicate key value violates unique constraint "acc_tests_no_dup"',
  };

  function makeClient(userId) {
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: userId } } } }) },
      rpc: async (name, args) => {
        if (name === 'register_device') {
          if (!devices.has(args.p_id)) devices.set(args.p_id, ++deviceSeq);
          return { data: devices.get(args.p_id), error: null };
        }
        if (name === 'device_max_numbers') return { data: {}, error: null };
        return { data: null, error: { message: 'unknown rpc' } };
      },
      from: (table) => builder(table),
    };
  }

  function builder(table) {
    const st = { op: 'select', filters: [], gt: null, range: null, single: false, payload: null };
    const b = {
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      select() { return b; },
      eq(k, v) { st.filters.push([k, v]); return b; },
      gt(k, v) { st.gt = [k, v]; return b; },
      order() { return b; },
      range(a, z) { st.range = [a, z]; return b; },
      maybeSingle() { st.single = true; return b; },
      single() { st.single = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    const match = (r) => st.filters.every(([k, v]) => r[k] === v);
    function run() {
      const tbl = T(table);
      if (st.op === 'insert') {
        const r = { ...st.payload };
        if (tbl.has(r.id)) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
        const u = uniqueChecks[table]?.(r, tbl);
        if (u) return { data: null, error: { code: '23505', message: u } };
        const row = { ...r, updated_at: tick(), row_version: 1 };
        tbl.set(r.id, row);
        if (failNextInsertResponse) { failNextInsertResponse = false; return { data: null, error: { message: 'TypeError: Failed to fetch' } }; }
        return { data: { ...row }, error: null };
      }
      if (st.op === 'update') {
        const out = [];
        for (const row of tbl.values()) {
          if (!match(row)) continue;
          Object.assign(row, st.payload, { updated_at: tick(), row_version: row.row_version + 1 });
          out.push({ ...row });
        }
        return { data: out, error: null };
      }
      let rows = [...tbl.values()].filter(match);
      if (st.gt) rows = rows.filter((r) => r[st.gt[0]] > st.gt[1]);
      rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
      if (st.range) rows = rows.slice(st.range[0], st.range[1] + 1);
      if (st.single) return { data: rows[0] ? { ...rows[0] } : null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    return b;
  }

  return { tables, makeClient, T, failInsertResponseOnce: () => { failNextInsertResponse = true; } };
}
