import { describe, it, expect } from 'vitest';
import { billTotals, computeCommissions, splitPackage, unitPrice, resolveRate } from '../src/lib/pricing.js';
import { buildResults, evalFormula, findRange, deltaChecks, reflexSuggestions, autoVerifyReason } from '../src/lib/results.js';
import { westgard } from '../src/lib/qc.js';

describe('pricing', () => {
  it('panel own rate beats panel discount, discount applies to list price', () => {
    const t = { id: 't1', price: 1000 };
    expect(unitPrice(t)).toBe(1000);
    expect(unitPrice(t, { id: 'p', discount_pct: 20 }, [])).toBe(800);
    expect(unitPrice(t, { id: 'p', discount_pct: 20 }, [{ panel_id: 'p', test_id: 't1', price: 650 }])).toBe(650);
  });
  it('package price is shared over its tests and adds up exactly', () => {
    const s = splitPackage(1000, [{ price: 300 }, { price: 300 }, { price: 400 }]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(1000);
    const odd = splitPackage(999, [{ price: 1 }, { price: 1 }, { price: 1 }]);
    expect(odd.reduce((a, b) => a + b, 0)).toBeCloseTo(999, 5);
  });
  it('bill: tests + home charge − discount; cancelled tests and deleted payments ignored', () => {
    const b = billTotals({ discount: 100, home_charge: 200 },
      [{ price: 1000, status: 'pending' }, { price: 500, status: 'cancelled' }],
      [{ kind: 'payment', amount: 600 }, { kind: 'payment', amount: 50, deleted_at: 'x' }, { kind: 'refund', amount: -100 }]);
    expect(b).toMatchObject({ subtotal: 1000, total: 1100, received: 600, refunded: 100, paid: 500, due: 600 });
  });
  it('panel credit bill: patient owes nothing, panel owes the balance', () => {
    const b = billTotals({ bill_to: 'panel' }, [{ price: 800, status: 'pending' }], []);
    expect(b.due).toBe(0); expect(b.panel_due).toBe(800);
  });
  it('commission: test rule → department rule → default; net basis shares the discount', () => {
    const doc = { id: 'd', rate_type: 'percent', rate_value: 30 };
    const rules = [
      { doctor_id: 'd', scope: 'department', department: 'Hormones', rate_type: 'percent', rate_value: 15 },
      { doctor_id: 'd', scope: 'test', test_id: 'cbc', rate_type: 'fixed', rate_value: 100 },
    ];
    const tests = [
      { id: 'a', test_id: 'cbc', department: 'Haematology', price: 800, status: 'pending' },
      { id: 'b', test_id: 'tsh', department: 'Hormones', price: 1000, status: 'pending' },
      { id: 'c', test_id: 'lft', department: 'Clinical Chemistry', price: 1200, status: 'pending' },
    ];
    expect(resolveRate(doc, rules, tests[0]).from).toBe('test');
    const gross = computeCommissions({ discount: 0 }, tests, doc, rules, 'gross');
    expect(gross.a.commission).toBe(100); expect(gross.b.commission).toBe(150); expect(gross.c.commission).toBe(360);
    const net = computeCommissions({ discount: 300 }, tests, doc, rules, 'net'); // 10% off every test
    expect(net.b.commission).toBe(135); expect(net.c.commission).toBe(324); expect(net.a.commission).toBe(100);
  });
});

describe('results', () => {
  const male = { gender: 'male', dob: '1980-01-01' }, female = { gender: 'female', dob: '1990-01-01' };
  it('gender-specific range wins', () => {
    const r = [{ gender: 'any', age_min_days: 0, low: 1, high: 2 }, { gender: 'male', age_min_days: 0, low: 13, high: 17 }];
    expect(findRange(r, male).low).toBe(13);
    expect(findRange(r, female).low).toBe(1);
  });
  it('formulas: LDL, eGFR with age/sex, safe against code', () => {
    expect(evalFormula('{TC}-{HDL}-{TG}/5', { TC: '200', HDL: '50', TG: '150' })).toBe(120);
    const e = evalFormula('142*pow(min({CREAT}/(FEMALE?0.7:0.9),1),(FEMALE?-0.241:-0.302))*pow(max({CREAT}/(FEMALE?0.7:0.9),1),-1.2)*pow(0.9938,AGE)*(FEMALE?1.012:1)', { CREAT: '1.0' }, { age: 50, female: false });
    expect(Math.round(e)).toBe(92); // CKD-EPI 2021, male 50 y, Scr 1.0 → 91.7
    expect(evalFormula('{A}+1', { A: '' })).toBeNull();
    expect(evalFormula('alert(1)', {})).toBeNull();
    expect(evalFormula('constructor', {})).toBeNull();
  });
  it('builds flags, critical and calculated values', () => {
    const params = [
      { id: 'tc', name: 'TC', code: 'TC', result_type: 'numeric', sort_order: 1 },
      { id: 'hdl', name: 'HDL', code: 'HDL', result_type: 'numeric', sort_order: 2 },
      { id: 'tg', name: 'TG', code: 'TG', result_type: 'numeric', sort_order: 3 },
      { id: 'ldl', name: 'LDL', result_type: 'calculated', formula: '{TC}-{HDL}-{TG}/5', decimals: 0, sort_order: 4 },
      { id: 'k', name: 'K', result_type: 'numeric', critical_high: 6, sort_order: 5 },
    ];
    const ranges = { ldl: [{ gender: 'any', age_min_days: 0, low: null, high: 100 }], k: [{ gender: 'any', age_min_days: 0, low: 3.5, high: 5.1 }] };
    const out = buildResults(params, { tc: '220', hdl: '40', tg: '200', k: '6.5' }, ranges, male);
    const ldl = out.find((r) => r.parameter_id === 'ldl');
    expect(ldl.value).toBe('140'); expect(ldl.flag).toBe('high');
    const k = out.find((r) => r.parameter_id === 'k');
    expect(k.flag).toBe('high'); expect(k.critical).toBe('high');
    expect(autoVerifyReason({}, out, [], true)).toMatch(/Critical/);
  });
  it('delta check and reflex', () => {
    const params = [{ id: 'hb', name: 'Hb', delta_pct: 20 }, { id: 'tsh', name: 'TSH', reflex: { when: 'abnormal', test: 'FT4' } }];
    const d = deltaChecks(params, [{ parameter_id: 'hb', value: '9' }], { hb: { value: '13', on: '2026-01-01' } });
    expect(d[0].pct).toBe(31);
    expect(reflexSuggestions(params, [{ parameter_id: 'tsh', name: 'TSH', flag: 'high' }])[0].code).toBe('FT4');
  });
  it('auto-verifies only clean results', () => {
    const ok = [{ value: '13', flag: 'normal', ref_text: '13 – 17' }];
    expect(autoVerifyReason({ auto_verify: true }, ok, [], true)).toBeNull();
    expect(autoVerifyReason({ auto_verify: true }, ok, [], false)).toMatch(/off/);
    expect(autoVerifyReason({ auto_verify: false }, ok, [], true)).toMatch(/manual/);
  });
});

describe('QC Westgard', () => {
  const runs = (v) => v.map((value) => ({ value }));
  it('detects rules', () => {
    expect(westgard(runs([100, 100.5]), 100, 1).status).toBe('ok');
    expect(westgard(runs([102.5]), 100, 1)).toEqual({ status: 'warning', rules: ['1-2s'] });
    expect(westgard(runs([103.5]), 100, 1).rules).toContain('1-3s');
    expect(westgard(runs([102.2, 102.4]), 100, 1).rules).toContain('2-2s');
    expect(westgard(runs([97.8, 102.3]), 100, 1).rules).toContain('R-4s');
    expect(westgard(runs([101.2, 101.5, 101.1, 101.3]), 100, 1).rules).toContain('4-1s');
    expect(westgard(runs(Array(10).fill(100.4)), 100, 1).rules).toContain('10x');
  });
});
