// Builds final_supabase.sql = sql/schema.sql + generated catalogue seed.
import { readFileSync, writeFileSync } from 'node:fs';
import { TESTS, PACKAGES, ANTIBIOTICS, TEMPLATES } from '../sql/catalogue.mjs';

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = [];
lines.push(`-- ${TESTS.length} tests, ${PACKAGES.length} packages, ${ANTIBIOTICS.length} antibiotics (generated from sql/catalogue.mjs)`);
for (const t of TESTS) {
  const o = { code: t.code, name: t.name, dept: t.dept, sample: t.sample, container: t.container, tat: t.tat,
    prep: t.prep, kind: t.kind, method: t.method, note: t.note, order: t.order * 10, auto: t.auto, params: t.params };
  lines.push(`select public._seed_test($j$${JSON.stringify(o)}$j$::jsonb);`);
}
PACKAGES.forEach(([code, name, codes], i) =>
  lines.push(`select public._seed_package(${q(code)}, ${q(name)}, ${5000 + i}, array[${codes.map(q).join(',')}]);`));
lines.push('insert into public.antibiotics (name, class, sort_order) values');
lines.push(ANTIBIOTICS.map(([n, c], i) => `  (${q(n)}, ${q(c)}, ${i + 1})`).join(',\n') + '\non conflict do nothing;');
lines.push('insert into public.report_templates (name, body) values');
lines.push(TEMPLATES.map(([n, b]) => `  (${q(n)}, ${q(b)})`).join(',\n') + '\non conflict do nothing;');
// templates are linked to the text-report tests
lines.push(`update public.lab_tests t set template_id = r.id from public.report_templates r
 where t.template_id is null and ((t.code in ('HISTS','HISTL') and r.name = 'Histopathology — standard')
   or (t.code = 'PAP' and r.name = 'Pap smear (Bethesda)') or (t.code = 'FNAC' and r.name = 'FNAC — standard')
   or (t.code = 'FCYTO' and r.name = 'Fluid cytology'));`);

const schema = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
writeFileSync(new URL('../final_supabase.sql', import.meta.url), schema.replace('-- @@SEED@@', lines.join('\n')));
console.log(`final_supabase.sql written: ${TESTS.length} tests, ${PACKAGES.length} packages`);
