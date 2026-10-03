// Starter test catalogue. Generates the seed section of final_supabase.sql
// (run: npm run sql). Reference ranges are common ADULT starter values from
// standard laboratory references — every lab must confirm them for its own
// analysers/methods (they are marked "not reviewed" in the app until then).
// No prices are set: the lab enters its own.

const ADULT = 6570; // 18 years in days

// ---- parameter helpers -----------------------------------------------------
// num(name, unit, lo, hi, opts)  — numeric, same range for both sexes
// sex(name, unit, [mLo,mHi], [fLo,fHi], opts) — numeric, male / female ranges
// opt(name, 'A,B,C', normal)     — pick-list (normal = expected value)
// txt(name, normal)              — free text
// calc(name, unit, formula, lo, hi, opts) — calculated from other parameters
const rng = (lo, hi, extra = {}) => {
  const r = { a0: ADULT, ...extra };
  if (lo != null) r.lo = lo;
  if (hi != null) r.hi = hi;
  return r;
};
const num = (n, u, lo, hi, o = {}) => ({ n, u, d: o.d ?? 1, r: lo == null && hi == null ? [] : [rng(lo, hi)], ...pick(o) });
const sex = (n, u, m, f, o = {}) => ({
  n, u, d: o.d ?? 1,
  r: [m[0] != null || m[1] != null ? rng(m[0], m[1], { g: 'male' }) : null, f[0] != null || f[1] != null ? rng(f[0], f[1], { g: 'female' }) : null].filter(Boolean),
  ...pick(o),
});
const opt = (n, o, normal, x = {}) => ({ n, t: 'option', o, r: normal ? [{ x: normal }] : [], ...pick(x) });
const txt = (n, normal, x = {}) => ({ n, t: 'text', r: normal ? [{ x: normal }] : [], ...pick(x) });
const calc = (n, u, f, lo, hi, o = {}) => ({ n, u, t: 'calculated', f, d: o.d ?? 1, r: lo == null && hi == null ? [] : [rng(lo, hi)], ...pick(o) });
function pick(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'd') continue;
    out[{ code: 'c', cl: 'cl', ch: 'ch', dp: 'dp', rx: 'rx', s: 's', u: 'u', dv: 'dv' }[k] || k] = v;
  }
  return out;
}
const POSNEG = 'Negative,Positive';
const REACT = 'Non-reactive,Reactive';
const PLUS = 'Nil,Trace,+,++,+++,++++';

// ---- departments -------------------------------------------------------------
const HEM = 'Haematology', COAG = 'Coagulation', CHEM = 'Clinical Chemistry', HORM = 'Hormones',
  TUM = 'Tumour Markers', SERO = 'Serology & Immunology', CP = 'Clinical Pathology', MICRO = 'Microbiology',
  HISTO = 'Histopathology & Cytology', BB = 'Blood Bank', MOL = 'Molecular';

let order = 0;
const T = (code, name, dept, sample, container, tat, params, more = {}) =>
  ({ code, name, dept, sample, container, tat, params, order: (order += 1), ...more });

const FAST = 'Fasting 8–10 hours (water allowed).';
const FAST12 = 'Fasting 10–12 hours (water allowed). No fatty meal the night before.';
const MORNING = 'Sample preferably between 8 and 10 AM.';
const BEFORE_AB = 'Collect before starting antibiotics. Use the sterile container given by the lab.';

export const TESTS = [
  // ============================ Haematology ============================
  T('CBC', 'Complete Blood Count (CBC)', HEM, 'Whole blood', 'EDTA (purple)', 4, [
    sex('Haemoglobin', 'g/dL', [13.0, 17.0], [12.0, 15.0], { code: 'HB', cl: 7, ch: 20, dp: 20 }),
    sex('RBC count', 'x10^6/µL', [4.5, 5.5], [3.8, 4.8], { code: 'RBC', d: 2 }),
    sex('Haematocrit (HCT)', '%', [40, 50], [36, 46], { code: 'HCT' }),
    num('MCV', 'fL', 80, 100, { code: 'MCV' }),
    num('MCH', 'pg', 27, 32, { code: 'MCH' }),
    num('MCHC', 'g/dL', 31.5, 34.5, { code: 'MCHC' }),
    num('RDW-CV', '%', 11.6, 14.0, { code: 'RDW' }),
    num('Total WBC count', 'x10^3/µL', 4.0, 11.0, { code: 'WBC', cl: 2, ch: 30, dp: 50 }),
    num('Neutrophils', '%', 40, 75, { code: 'NEU', d: 0, s: 'Differential count' }),
    num('Lymphocytes', '%', 20, 45, { code: 'LYM', d: 0, s: 'Differential count' }),
    num('Monocytes', '%', 2, 10, { code: 'MONO', d: 0, s: 'Differential count' }),
    num('Eosinophils', '%', 1, 6, { code: 'EOS', d: 0, s: 'Differential count' }),
    num('Basophils', '%', 0, 2, { code: 'BASO', d: 0, s: 'Differential count' }),
    num('Platelet count', 'x10^3/µL', 150, 400, { code: 'PLT', d: 0, cl: 30, ch: 1000, dp: 40 }),
  ]),
  T('HB', 'Haemoglobin (Hb)', HEM, 'Whole blood', 'EDTA (purple)', 2, [
    sex('Haemoglobin', 'g/dL', [13.0, 17.0], [12.0, 15.0], { code: 'HB', cl: 7, ch: 20, dp: 20 })]),
  T('TLCDLC', 'TLC & DLC', HEM, 'Whole blood', 'EDTA (purple)', 3, [
    num('Total WBC count', 'x10^3/µL', 4.0, 11.0, { code: 'WBC', cl: 2, ch: 30 }),
    num('Neutrophils', '%', 40, 75, { d: 0 }), num('Lymphocytes', '%', 20, 45, { d: 0 }),
    num('Monocytes', '%', 2, 10, { d: 0 }), num('Eosinophils', '%', 1, 6, { d: 0 }), num('Basophils', '%', 0, 2, { d: 0 })]),
  T('PLT', 'Platelet Count', HEM, 'Whole blood', 'EDTA (purple)', 2, [
    num('Platelet count', 'x10^3/µL', 150, 400, { code: 'PLT', d: 0, cl: 30, ch: 1000 })]),
  T('ESR', 'ESR (Westergren)', HEM, 'Whole blood', 'EDTA / Citrate', 2, [
    sex('ESR (1st hour)', 'mm/hr', [0, 15], [0, 20], { d: 0 })]),
  T('RETIC', 'Reticulocyte Count', HEM, 'Whole blood', 'EDTA (purple)', 6, [num('Reticulocytes', '%', 0.5, 2.5)]),
  T('AEC', 'Absolute Eosinophil Count', HEM, 'Whole blood', 'EDTA (purple)', 4, [num('Absolute eosinophil count', '/µL', 40, 440, { d: 0 })]),
  T('PS', 'Peripheral Blood Smear', HEM, 'Whole blood', 'EDTA (purple)', 24, [
    txt('RBC morphology', 'Normocytic normochromic'), txt('WBC morphology', 'Normal'), txt('Platelets', 'Adequate'),
    txt('Haemoparasites', 'Not seen'), txt('Impression', '')], { auto: false }),
  T('MP', 'Malaria Parasite (Smear)', HEM, 'Whole blood', 'EDTA (purple)', 2, [
    opt('Malaria parasite', 'Not seen,P. vivax seen,P. falciparum seen,Mixed infection', 'Not seen')]),
  T('MPICT', 'Malaria Antigen (ICT)', HEM, 'Whole blood', 'EDTA (purple)', 1, [
    opt('P. falciparum antigen', POSNEG, 'Negative'), opt('P. vivax antigen', POSNEG, 'Negative')]),
  T('BG', 'Blood Group & Rh', BB, 'Whole blood', 'EDTA (purple)', 1, [
    opt('ABO group', 'A,B,AB,O'), opt('Rh (D) factor', 'Positive,Negative')]),
  T('G6PD', 'G6PD Screening', HEM, 'Whole blood', 'EDTA (purple)', 24, [opt('G6PD', 'Normal,Deficient', 'Normal')]),
  T('SICK', 'Sickling Test', HEM, 'Whole blood', 'EDTA (purple)', 24, [opt('Sickling', POSNEG, 'Negative')]),
  T('HBEP', 'Hb Electrophoresis', HEM, 'Whole blood', 'EDTA (purple)', 72, [
    num('HbA', '%', 95, 98), num('HbA2', '%', 1.5, 3.5), num('HbF', '%', 0, 2), txt('Abnormal bands', 'None'),
    txt('Interpretation', '')], { auto: false }),

  // ============================ Coagulation ============================
  T('PT', 'Prothrombin Time (PT / INR)', COAG, 'Plasma', 'Citrate (blue)', 3, [
    num('PT (patient)', 'sec', 11, 13.5, { code: 'PTP' }), num('PT (control)', 'sec', null, null, { code: 'PTC' }),
    num('INR', '', 0.8, 1.2, { code: 'INR', d: 2, ch: 5 })]),
  T('APTT', 'APTT', COAG, 'Plasma', 'Citrate (blue)', 3, [
    num('APTT (patient)', 'sec', 25, 35), num('APTT (control)', 'sec', null, null)]),
  T('BTCT', 'Bleeding Time & Clotting Time', COAG, 'Capillary blood', '—', 1, [
    txt('Bleeding time', '2 – 7 min'), txt('Clotting time', '5 – 10 min')]),
  T('FIB', 'Fibrinogen', COAG, 'Plasma', 'Citrate (blue)', 6, [num('Fibrinogen', 'mg/dL', 200, 400, { d: 0, cl: 100 })]),
  T('DDIM', 'D-Dimer', COAG, 'Plasma', 'Citrate (blue)', 4, [num('D-Dimer', 'µg/mL FEU', 0, 0.5, { d: 2 })]),

  // ============================ Clinical Chemistry =====================
  T('BSF', 'Blood Sugar (Fasting)', CHEM, 'Plasma', 'Fluoride (grey)', 2, [
    num('Fasting blood glucose', 'mg/dL', 70, 99, { code: 'FBS', d: 0, cl: 50, ch: 400 })], { prep: FAST }),
  T('BSR', 'Blood Sugar (Random)', CHEM, 'Plasma', 'Fluoride (grey)', 1, [
    num('Random blood glucose', 'mg/dL', 70, 140, { code: 'RBS', d: 0, cl: 50, ch: 400 })]),
  T('BSPP', 'Blood Sugar (2 hours after meal)', CHEM, 'Plasma', 'Fluoride (grey)', 2, [
    num('2-hour post-prandial glucose', 'mg/dL', 70, 140, { d: 0, cl: 50, ch: 400 })], { prep: 'Sample exactly 2 hours after starting a normal meal.' }),
  T('OGTT', 'Glucose Tolerance Test (75 g OGTT)', CHEM, 'Plasma', 'Fluoride (grey)', 4, [
    num('Fasting glucose', 'mg/dL', 70, 99, { d: 0, cl: 50, ch: 400 }), num('Glucose at 1 hour', 'mg/dL', null, 180, { d: 0 }),
    num('Glucose at 2 hours', 'mg/dL', null, 140, { d: 0 })], { prep: FAST + ' Stay at the lab for 2 hours after the glucose drink.' }),
  T('HBA1C', 'HbA1c (Glycated Haemoglobin)', CHEM, 'Whole blood', 'EDTA (purple)', 4, [
    num('HbA1c', '%', 4.0, 5.6, { code: 'A1C' }),
    calc('Estimated average glucose (eAG)', 'mg/dL', '28.7*{A1C}-46.7', null, null, { d: 0 })],
    { note: 'HbA1c: below 5.7% normal · 5.7–6.4% prediabetes · 6.5% or more diabetes (ADA).' }),
  T('LFT', 'Liver Function Tests (LFT)', CHEM, 'Serum', 'Gel / Red', 4, [
    num('Total bilirubin', 'mg/dL', 0.3, 1.2, { code: 'TBIL', ch: 15 }),
    num('Direct bilirubin', 'mg/dL', 0, 0.3, { code: 'DBIL' }),
    calc('Indirect bilirubin', 'mg/dL', '{TBIL}-{DBIL}', 0.2, 0.9),
    num('ALT (SGPT)', 'U/L', 0, 40, { d: 0 }), num('AST (SGOT)', 'U/L', 0, 40, { d: 0 }),
    num('Alkaline phosphatase', 'U/L', 40, 130, { d: 0 }), num('Gamma GT', 'U/L', 0, 55, { d: 0 }),
    num('Total protein', 'g/dL', 6.0, 8.3, { code: 'TP' }), num('Albumin', 'g/dL', 3.5, 5.0, { code: 'ALB' }),
    calc('Globulin', 'g/dL', '{TP}-{ALB}', 2.0, 3.5, { code: 'GLOB' }),
    calc('A/G ratio', '', '{ALB}/({TP}-{ALB})', 1.0, 2.2, { d: 2 })]),
  T('BIL', 'Bilirubin (Total & Direct)', CHEM, 'Serum', 'Gel / Red', 3, [
    num('Total bilirubin', 'mg/dL', 0.3, 1.2, { code: 'TBIL', ch: 15 }), num('Direct bilirubin', 'mg/dL', 0, 0.3, { code: 'DBIL' }),
    calc('Indirect bilirubin', 'mg/dL', '{TBIL}-{DBIL}', 0.2, 0.9)]),
  T('ALT', 'ALT (SGPT)', CHEM, 'Serum', 'Gel / Red', 3, [num('ALT (SGPT)', 'U/L', 0, 40, { d: 0 })]),
  T('AST', 'AST (SGOT)', CHEM, 'Serum', 'Gel / Red', 3, [num('AST (SGOT)', 'U/L', 0, 40, { d: 0 })]),
  T('ALP', 'Alkaline Phosphatase', CHEM, 'Serum', 'Gel / Red', 3, [num('Alkaline phosphatase', 'U/L', 40, 130, { d: 0 })]),
  T('GGT', 'Gamma GT', CHEM, 'Serum', 'Gel / Red', 3, [num('Gamma GT', 'U/L', 0, 55, { d: 0 })]),
  T('TPALB', 'Total Protein & Albumin', CHEM, 'Serum', 'Gel / Red', 3, [
    num('Total protein', 'g/dL', 6.0, 8.3, { code: 'TP' }), num('Albumin', 'g/dL', 3.5, 5.0, { code: 'ALB' }),
    calc('Globulin', 'g/dL', '{TP}-{ALB}', 2.0, 3.5), calc('A/G ratio', '', '{ALB}/({TP}-{ALB})', 1.0, 2.2, { d: 2 })]),
  T('RFT', 'Renal Function Tests (RFT)', CHEM, 'Serum', 'Gel / Red', 4, [
    num('Urea', 'mg/dL', 15, 45, { code: 'UREA', d: 0 }),
    calc('BUN', 'mg/dL', '{UREA}*0.467', 7, 21, { d: 0 }),
    sex('Creatinine', 'mg/dL', [0.7, 1.3], [0.6, 1.1], { code: 'CREAT', d: 2, ch: 5, dp: 50 }),
    calc('eGFR (CKD-EPI 2021)', 'mL/min/1.73m²',
      '142*pow(min({CREAT}/(FEMALE?0.7:0.9),1),(FEMALE?-0.241:-0.302))*pow(max({CREAT}/(FEMALE?0.7:0.9),1),-1.2)*pow(0.9938,AGE)*(FEMALE?1.012:1)',
      90, null, { d: 0 }),
    sex('Uric acid', 'mg/dL', [3.5, 7.2], [2.6, 6.0]),
    num('Sodium', 'mmol/L', 135, 145, { d: 0, cl: 125, ch: 155 }),
    num('Potassium', 'mmol/L', 3.5, 5.1, { cl: 3.0, ch: 6.0, dp: 20 }),
    num('Chloride', 'mmol/L', 98, 107, { d: 0 })]),
  T('UREA', 'Urea', CHEM, 'Serum', 'Gel / Red', 3, [num('Urea', 'mg/dL', 15, 45, { d: 0 })]),
  T('CREAT', 'Creatinine', CHEM, 'Serum', 'Gel / Red', 3, [
    sex('Creatinine', 'mg/dL', [0.7, 1.3], [0.6, 1.1], { code: 'CREAT', d: 2, ch: 5, dp: 50 }),
    calc('eGFR (CKD-EPI 2021)', 'mL/min/1.73m²',
      '142*pow(min({CREAT}/(FEMALE?0.7:0.9),1),(FEMALE?-0.241:-0.302))*pow(max({CREAT}/(FEMALE?0.7:0.9),1),-1.2)*pow(0.9938,AGE)*(FEMALE?1.012:1)',
      90, null, { d: 0 })]),
  T('UA', 'Uric Acid', CHEM, 'Serum', 'Gel / Red', 3, [sex('Uric acid', 'mg/dL', [3.5, 7.2], [2.6, 6.0])]),
  T('ELEC', 'Serum Electrolytes', CHEM, 'Serum', 'Gel / Red', 3, [
    num('Sodium', 'mmol/L', 135, 145, { d: 0, cl: 125, ch: 155 }), num('Potassium', 'mmol/L', 3.5, 5.1, { cl: 3.0, ch: 6.0, dp: 20 }),
    num('Chloride', 'mmol/L', 98, 107, { d: 0 }), num('Bicarbonate', 'mmol/L', 22, 29, { d: 0, cl: 12, ch: 40 })]),
  T('CA', 'Serum Calcium', CHEM, 'Serum', 'Gel / Red', 3, [num('Calcium', 'mg/dL', 8.5, 10.5, { cl: 7, ch: 12 })]),
  T('ICA', 'Ionised Calcium', CHEM, 'Serum', 'Gel / Red', 4, [num('Ionised calcium', 'mmol/L', 1.12, 1.32, { d: 2 })]),
  T('PHOS', 'Serum Phosphorus', CHEM, 'Serum', 'Gel / Red', 3, [num('Phosphorus', 'mg/dL', 2.5, 4.5)]),
  T('MG', 'Serum Magnesium', CHEM, 'Serum', 'Gel / Red', 3, [num('Magnesium', 'mg/dL', 1.7, 2.4, { cl: 1.0 })]),
  T('LIPID', 'Lipid Profile', CHEM, 'Serum', 'Gel / Red', 4, [
    num('Total cholesterol', 'mg/dL', null, 200, { code: 'TC', d: 0 }),
    num('Triglycerides', 'mg/dL', null, 150, { code: 'TG', d: 0 }),
    sex('HDL cholesterol', 'mg/dL', [40, null], [50, null], { code: 'HDL', d: 0 }),
    calc('LDL cholesterol (calculated)', 'mg/dL', '{TC}-{HDL}-{TG}/5', null, 100, { d: 0 }),
    calc('VLDL cholesterol', 'mg/dL', '{TG}/5', 5, 40, { d: 0 }),
    calc('Non-HDL cholesterol', 'mg/dL', '{TC}-{HDL}', null, 130, { d: 0 }),
    calc('Cholesterol / HDL ratio', '', '{TC}/{HDL}', null, 5, { d: 1 })],
    { prep: FAST12, note: 'Calculated LDL (Friedewald) is not valid when triglycerides are above 400 mg/dL.' }),
  T('CHOL', 'Cholesterol (Total)', CHEM, 'Serum', 'Gel / Red', 3, [num('Total cholesterol', 'mg/dL', null, 200, { d: 0 })]),
  T('TG', 'Triglycerides', CHEM, 'Serum', 'Gel / Red', 3, [num('Triglycerides', 'mg/dL', null, 150, { d: 0 })], { prep: FAST12 }),
  T('AMY', 'Serum Amylase', CHEM, 'Serum', 'Gel / Red', 3, [num('Amylase', 'U/L', 28, 100, { d: 0 })]),
  T('LIP', 'Serum Lipase', CHEM, 'Serum', 'Gel / Red', 3, [num('Lipase', 'U/L', 13, 60, { d: 0 })]),
  T('CK', 'CPK (Total CK)', CHEM, 'Serum', 'Gel / Red', 3, [sex('CK (total)', 'U/L', [39, 308], [26, 192], { d: 0 })]),
  T('CKMB', 'CK-MB', CHEM, 'Serum', 'Gel / Red', 3, [num('CK-MB', 'U/L', 0, 25, { d: 0 })]),
  T('LDH', 'LDH', CHEM, 'Serum', 'Gel / Red', 3, [num('LDH', 'U/L', 140, 280, { d: 0 })]),
  T('TROPI', 'Troponin I (Quantitative)', CHEM, 'Serum', 'Gel / Red', 1, [num('Troponin I', 'ng/mL', 0, 0.04, { d: 3, ch: 0.04 })], { auto: false }),
  T('TROPT', 'Troponin T (Rapid)', CHEM, 'Whole blood', 'Heparin / EDTA', 1, [opt('Troponin T', POSNEG, 'Negative')], { auto: false }),
  T('CRP', 'C-Reactive Protein (CRP)', CHEM, 'Serum', 'Gel / Red', 3, [num('CRP', 'mg/L', 0, 5)]),
  T('HSCRP', 'hs-CRP', CHEM, 'Serum', 'Gel / Red', 6, [num('hs-CRP', 'mg/L', 0, 1, { d: 2 })],
    { note: 'Cardiac risk: below 1 mg/L low · 1–3 average · above 3 high.' }),
  T('PCT', 'Procalcitonin', CHEM, 'Serum', 'Gel / Red', 4, [num('Procalcitonin', 'ng/mL', 0, 0.5, { d: 2 })]),
  T('BNP', 'NT-proBNP', CHEM, 'Serum', 'Gel / Red', 6, [num('NT-proBNP', 'pg/mL', 0, 125, { d: 0 })]),
  T('HCY', 'Homocysteine', CHEM, 'Serum', 'Gel / Red', 24, [num('Homocysteine', 'µmol/L', 5, 15)]),
  T('IRON', 'Iron Studies (Fe, TIBC, Ferritin)', CHEM, 'Serum', 'Gel / Red', 6, [
    sex('Serum iron', 'µg/dL', [65, 175], [50, 170], { code: 'FE', d: 0 }),
    num('TIBC', 'µg/dL', 250, 450, { code: 'TIBC', d: 0 }),
    calc('Transferrin saturation', '%', '{FE}/{TIBC}*100', 20, 50, { d: 0 }),
    sex('Ferritin', 'ng/mL', [30, 400], [15, 150], { d: 0 })]),
  T('FE', 'Serum Iron', CHEM, 'Serum', 'Gel / Red', 4, [sex('Serum iron', 'µg/dL', [65, 175], [50, 170], { d: 0 })]),
  T('FERR', 'Serum Ferritin', CHEM, 'Serum', 'Gel / Red', 6, [sex('Ferritin', 'ng/mL', [30, 400], [15, 150], { d: 0 })]),
  T('B12', 'Vitamin B12', CHEM, 'Serum', 'Gel / Red', 24, [num('Vitamin B12', 'pg/mL', 200, 900, { d: 0 })]),
  T('FOL', 'Folate (Serum)', CHEM, 'Serum', 'Gel / Red', 24, [num('Folate', 'ng/mL', 3, 17)]),
  T('VITD', 'Vitamin D (25-OH)', CHEM, 'Serum', 'Gel / Red', 24, [num('25-OH Vitamin D', 'ng/mL', 30, 100)],
    { note: 'Below 20 ng/mL deficient · 20–29 insufficient · 30–100 sufficient.' }),
  T('ZN', 'Serum Zinc', CHEM, 'Serum', 'Trace-element tube', 48, [num('Zinc', 'µg/dL', 70, 120, { d: 0 })]),
  T('NH3', 'Ammonia', CHEM, 'Plasma', 'EDTA on ice', 2, [num('Ammonia', 'µmol/L', 11, 32, { d: 0 })],
    { prep: 'Sample must reach the lab on ice within 30 minutes.' }),
  T('LACT', 'Lactate', CHEM, 'Plasma', 'Fluoride (grey)', 2, [num('Lactate', 'mmol/L', 0.5, 2.2, { ch: 4 })]),
  T('MALB', 'Urine Microalbumin (ACR)', CHEM, 'Urine', 'Sterile container', 6, [
    num('Urine albumin', 'mg/L', null, null, { code: 'UALB' }), num('Urine creatinine', 'mg/dL', null, null, { code: 'UCR' }),
    calc('Albumin / creatinine ratio', 'mg/g', '{UALB}/{UCR}*100', null, 30, { d: 0 })],
    { prep: 'Early-morning urine sample.', note: 'ACR: below 30 normal · 30–300 moderately increased · above 300 severely increased.' }),
  T('UPROT24', '24-hour Urine Protein', CHEM, 'Urine (24 h)', '24-hour container', 24, [
    num('Urine volume', 'mL', null, null, { code: 'VOL', d: 0 }), num('Protein concentration', 'mg/dL', null, null, { code: 'UP' }),
    calc('Protein (24 hours)', 'mg/24 h', '{UP}*{VOL}/100', null, 150, { d: 0 })],
    { prep: 'Collect all urine for 24 hours in the container given by the lab. Discard the first morning sample, then collect every sample until the same time next morning.' }),

  // ============================ Hormones ===============================
  T('TSH', 'TSH', HORM, 'Serum', 'Gel / Red', 6, [num('TSH', 'µIU/mL', 0.4, 4.0, { code: 'TSH', d: 2, rx: { when: 'abnormal', test: 'FT4' } })]),
  T('FT4', 'Free T4', HORM, 'Serum', 'Gel / Red', 6, [num('Free T4', 'ng/dL', 0.8, 1.8, { d: 2 })]),
  T('FT3', 'Free T3', HORM, 'Serum', 'Gel / Red', 6, [num('Free T3', 'pg/mL', 2.3, 4.2, { d: 2 })]),
  T('T3', 'T3 (Total)', HORM, 'Serum', 'Gel / Red', 6, [num('T3 (total)', 'ng/dL', 80, 200, { d: 0 })]),
  T('T4', 'T4 (Total)', HORM, 'Serum', 'Gel / Red', 6, [num('T4 (total)', 'µg/dL', 5.0, 12.0)]),
  T('TFT', 'Thyroid Profile (TSH, FT4)', HORM, 'Serum', 'Gel / Red', 6, [
    num('TSH', 'µIU/mL', 0.4, 4.0, { d: 2 }), num('Free T4', 'ng/dL', 0.8, 1.8, { d: 2 })]),
  T('TFTF', 'Thyroid Profile (FT3, FT4, TSH)', HORM, 'Serum', 'Gel / Red', 6, [
    num('Free T3', 'pg/mL', 2.3, 4.2, { d: 2 }), num('Free T4', 'ng/dL', 0.8, 1.8, { d: 2 }), num('TSH', 'µIU/mL', 0.4, 4.0, { d: 2 })]),
  T('TFTT', 'Thyroid Profile (T3, T4, TSH)', HORM, 'Serum', 'Gel / Red', 6, [
    num('T3 (total)', 'ng/dL', 80, 200, { d: 0 }), num('T4 (total)', 'µg/dL', 5.0, 12.0), num('TSH', 'µIU/mL', 0.4, 4.0, { d: 2 })]),
  T('ATPO', 'Anti-TPO Antibodies', HORM, 'Serum', 'Gel / Red', 24, [num('Anti-TPO', 'IU/mL', 0, 34, { d: 0 })]),
  T('PRL', 'Prolactin', HORM, 'Serum', 'Gel / Red', 6, [sex('Prolactin', 'ng/mL', [4.0, 15.2], [4.8, 23.3])],
    { prep: MORNING + ' Rest for 30 minutes before the sample.' }),
  T('LH', 'LH', HORM, 'Serum', 'Gel / Red', 6, [sex('LH', 'mIU/mL', [1.7, 8.6], [null, null])],
    { note: 'Female LH varies with cycle phase: follicular 2.4–12.6 · mid-cycle 14–96 · luteal 1.0–11.4 · post-menopause 7.7–59 mIU/mL.' }),
  T('FSH', 'FSH', HORM, 'Serum', 'Gel / Red', 6, [sex('FSH', 'mIU/mL', [1.5, 12.4], [null, null])],
    { note: 'Female FSH varies with cycle phase: follicular 3.5–12.5 · mid-cycle 4.7–21.5 · luteal 1.7–7.7 · post-menopause 25.8–134.8 mIU/mL.' }),
  T('E2', 'Estradiol (E2)', HORM, 'Serum', 'Gel / Red', 6, [num('Estradiol', 'pg/mL', null, null, { d: 0 })],
    { note: 'Female estradiol varies with cycle phase: follicular 12.5–166 · mid-cycle 85.8–498 · luteal 43.8–211 · post-menopause below 54.7 pg/mL. Male 7.6–42.6 pg/mL.' }),
  T('PROG', 'Progesterone', HORM, 'Serum', 'Gel / Red', 6, [num('Progesterone', 'ng/mL', null, null, { d: 2 })],
    { note: 'Female: follicular 0.06–0.89 · luteal 1.8–23.9 ng/mL (peak on day 21). Male 0.2–1.4 ng/mL.' }),
  T('TESTO', 'Testosterone (Total)', HORM, 'Serum', 'Gel / Red', 6, [sex('Testosterone', 'ng/dL', [264, 916], [15, 70], { d: 0 })], { prep: MORNING }),
  T('BHCG', 'Beta hCG (Quantitative)', HORM, 'Serum', 'Gel / Red', 3, [num('β-hCG', 'mIU/mL', 0, 5, { d: 0 })],
    { note: 'Above 25 mIU/mL is generally consistent with pregnancy; correlate with dates.' }),
  T('CORT', 'Cortisol (Morning)', HORM, 'Serum', 'Gel / Red', 6, [num('Cortisol (8–10 AM)', 'µg/dL', 6.2, 19.4)], { prep: 'Sample between 8 and 10 AM.' }),
  T('INS', 'Insulin (Fasting)', HORM, 'Serum', 'Gel / Red', 24, [num('Fasting insulin', 'µIU/mL', 2.6, 24.9)], { prep: FAST }),
  T('CPEP', 'C-Peptide', HORM, 'Serum', 'Gel / Red', 24, [num('C-peptide', 'ng/mL', 1.1, 4.4)], { prep: FAST }),
  T('PTH', 'Parathyroid Hormone (PTH)', HORM, 'Serum', 'EDTA (purple)', 24, [num('PTH (intact)', 'pg/mL', 15, 65, { d: 0 })]),
  T('AMH', 'Anti-Müllerian Hormone (AMH)', HORM, 'Serum', 'Gel / Red', 48, [num('AMH', 'ng/mL', null, null, { d: 2 })],
    { note: 'AMH falls with age; interpret against age-specific values for ovarian reserve.' }),
  T('DHEAS', 'DHEA-S', HORM, 'Serum', 'Gel / Red', 48, [sex('DHEA-S', 'µg/dL', [80, 560], [35, 430], { d: 0 })]),

  // ============================ Tumour markers =========================
  T('PSA', 'PSA (Total)', TUM, 'Serum', 'Gel / Red', 24, [num('PSA (total)', 'ng/mL', 0, 4, { d: 2 })],
    { prep: 'Avoid ejaculation and cycling for 48 hours before the test.' }),
  T('FPSA', 'PSA (Free & Total)', TUM, 'Serum', 'Gel / Red', 24, [
    num('PSA (total)', 'ng/mL', 0, 4, { code: 'TPSA', d: 2 }), num('PSA (free)', 'ng/mL', null, null, { code: 'FPSA', d: 2 }),
    calc('Free / total PSA', '%', '{FPSA}/{TPSA}*100', 25, null, { d: 0 })]),
  T('CEA', 'CEA', TUM, 'Serum', 'Gel / Red', 24, [num('CEA', 'ng/mL', 0, 5)], { note: 'Smokers may have values up to 10 ng/mL.' }),
  T('CA125', 'CA-125', TUM, 'Serum', 'Gel / Red', 24, [num('CA-125', 'U/mL', 0, 35)]),
  T('CA199', 'CA 19-9', TUM, 'Serum', 'Gel / Red', 24, [num('CA 19-9', 'U/mL', 0, 37)]),
  T('CA153', 'CA 15-3', TUM, 'Serum', 'Gel / Red', 24, [num('CA 15-3', 'U/mL', 0, 30)]),
  T('AFP', 'Alpha-Fetoprotein (AFP)', TUM, 'Serum', 'Gel / Red', 24, [num('AFP', 'ng/mL', 0, 10)]),

  // ============================ Serology & Immunology ==================
  T('HBSAG', 'HBsAg (Hepatitis B)', SERO, 'Serum', 'Gel / Red', 2, [
    opt('HBsAg', REACT, 'Non-reactive', { rx: { when: 'abnormal', test: 'HBVPCR' } })], { method: 'Immunochromatography (ICT)' }),
  T('HCV', 'Anti-HCV (Hepatitis C)', SERO, 'Serum', 'Gel / Red', 2, [
    opt('Anti-HCV', REACT, 'Non-reactive', { rx: { when: 'abnormal', test: 'HCVPCR' } })], { method: 'Immunochromatography (ICT)' }),
  T('HIV', 'HIV 1 & 2 Antibodies', SERO, 'Serum', 'Gel / Red', 2, [opt('HIV 1 & 2 antibodies', REACT, 'Non-reactive')], { auto: false }),
  T('HBSAGE', 'HBsAg (ELISA / CLIA)', SERO, 'Serum', 'Gel / Red', 24, [
    num('HBsAg index (S/CO)', '', null, 1, { d: 2 }), opt('Result', REACT, 'Non-reactive')]),
  T('HCVE', 'Anti-HCV (ELISA / CLIA)', SERO, 'Serum', 'Gel / Red', 24, [
    num('Anti-HCV index (S/CO)', '', null, 1, { d: 2 }), opt('Result', REACT, 'Non-reactive')]),
  T('HBEAG', 'HBeAg', SERO, 'Serum', 'Gel / Red', 24, [opt('HBeAg', REACT, 'Non-reactive')]),
  T('AHBS', 'Anti-HBs (Titre)', SERO, 'Serum', 'Gel / Red', 24, [num('Anti-HBs', 'mIU/mL', 10, null, { d: 0 })],
    { note: '10 mIU/mL or more indicates protective immunity.' }),
  T('AHBC', 'Anti-HBc (Total)', SERO, 'Serum', 'Gel / Red', 24, [opt('Anti-HBc', REACT, 'Non-reactive')]),
  T('HAV', 'Hepatitis A IgM', SERO, 'Serum', 'Gel / Red', 24, [opt('Anti-HAV IgM', REACT, 'Non-reactive')]),
  T('HEV', 'Hepatitis E IgM', SERO, 'Serum', 'Gel / Red', 24, [opt('Anti-HEV IgM', REACT, 'Non-reactive')]),
  T('VDRL', 'VDRL / RPR', SERO, 'Serum', 'Gel / Red', 4, [opt('VDRL', REACT, 'Non-reactive')]),
  T('TYPHI', 'Typhidot (IgM / IgG)', SERO, 'Serum', 'Gel / Red', 2, [
    opt('Typhidot IgM', POSNEG, 'Negative'), opt('Typhidot IgG', POSNEG, 'Negative')]),
  T('WIDAL', 'Widal Test', SERO, 'Serum', 'Gel / Red', 4, [
    opt('S. Typhi O', 'Below 1:80,1:80,1:160,1:320,1:640', 'Below 1:80'),
    opt('S. Typhi H', 'Below 1:80,1:80,1:160,1:320,1:640', 'Below 1:80'),
    opt('S. Paratyphi AH', 'Below 1:80,1:80,1:160,1:320,1:640', 'Below 1:80'),
    opt('S. Paratyphi BH', 'Below 1:80,1:80,1:160,1:320,1:640', 'Below 1:80')]),
  T('DENGNS1', 'Dengue NS1 Antigen', SERO, 'Serum', 'Gel / Red', 2, [opt('Dengue NS1 antigen', POSNEG, 'Negative')]),
  T('DENGAB', 'Dengue IgM / IgG', SERO, 'Serum', 'Gel / Red', 2, [
    opt('Dengue IgM', POSNEG, 'Negative'), opt('Dengue IgG', POSNEG, 'Negative')]),
  T('HPYS', 'H. pylori Antibody (Serum)', SERO, 'Serum', 'Gel / Red', 2, [opt('H. pylori antibody', POSNEG, 'Negative')]),
  T('HPYAG', 'H. pylori Stool Antigen', SERO, 'Stool', 'Stool container', 4, [opt('H. pylori stool antigen', POSNEG, 'Negative')]),
  T('RA', 'Rheumatoid Factor (RA)', SERO, 'Serum', 'Gel / Red', 4, [num('RA factor', 'IU/mL', 0, 14, { d: 0 })]),
  T('ASO', 'ASO Titre', SERO, 'Serum', 'Gel / Red', 4, [num('ASO', 'IU/mL', 0, 200, { d: 0 })]),
  T('ANA', 'ANA (Antinuclear Antibody)', SERO, 'Serum', 'Gel / Red', 48, [
    opt('ANA', POSNEG, 'Negative'), txt('Titre / pattern', '')]),
  T('DSDNA', 'Anti-dsDNA', SERO, 'Serum', 'Gel / Red', 48, [num('Anti-dsDNA', 'IU/mL', 0, 25, { d: 0 })]),
  T('BRUC', 'Brucella Antibodies', SERO, 'Serum', 'Gel / Red', 4, [
    opt('Brucella abortus', 'Below 1:80,1:80,1:160,1:320', 'Below 1:80'), opt('Brucella melitensis', 'Below 1:80,1:80,1:160,1:320', 'Below 1:80')]),
  T('TBICT', 'TB Antibody (ICT)', SERO, 'Serum', 'Gel / Red', 2, [opt('TB IgM', POSNEG, 'Negative'), opt('TB IgG', POSNEG, 'Negative')]),
  T('TOXO', 'Toxoplasma IgG / IgM', SERO, 'Serum', 'Gel / Red', 24, [
    opt('Toxoplasma IgG', REACT, 'Non-reactive'), opt('Toxoplasma IgM', REACT, 'Non-reactive')]),
  T('RUB', 'Rubella IgG / IgM', SERO, 'Serum', 'Gel / Red', 24, [
    opt('Rubella IgG', REACT, ''), opt('Rubella IgM', REACT, 'Non-reactive')]),
  T('CMV', 'CMV IgG / IgM', SERO, 'Serum', 'Gel / Red', 24, [
    opt('CMV IgG', REACT, ''), opt('CMV IgM', REACT, 'Non-reactive')]),
  T('TTG', 'Anti-tTG IgA (Celiac)', SERO, 'Serum', 'Gel / Red', 48, [num('Anti-tTG IgA', 'U/mL', 0, 20, { d: 1 })]),
  T('IGE', 'IgE (Total)', SERO, 'Serum', 'Gel / Red', 24, [num('Total IgE', 'IU/mL', 0, 100, { d: 0 })]),
  T('COVAG', 'COVID-19 Antigen (Rapid)', SERO, 'Nasal swab', 'Swab', 1, [opt('SARS-CoV-2 antigen', POSNEG, 'Negative')]),

  // ============================ Clinical Pathology =====================
  T('URE', 'Urine Routine Examination', CP, 'Urine', 'Sterile container', 2, [
    opt('Colour', 'Pale yellow,Yellow,Dark yellow,Amber,Red,Brown', 'Pale yellow', { s: 'Physical' }),
    opt('Appearance', 'Clear,Slightly turbid,Turbid', 'Clear', { s: 'Physical' }),
    num('pH', '', null, null, { s: 'Chemical', d: 1 }),
    num('Specific gravity', '', null, null, { s: 'Chemical', d: 3 }),
    opt('Protein', PLUS, 'Nil', { s: 'Chemical' }), opt('Glucose', PLUS, 'Nil', { s: 'Chemical' }),
    opt('Ketones', PLUS, 'Nil', { s: 'Chemical' }), opt('Blood', PLUS, 'Nil', { s: 'Chemical' }),
    opt('Bilirubin', 'Negative,Positive', 'Negative', { s: 'Chemical' }), opt('Urobilinogen', 'Normal,Increased', 'Normal', { s: 'Chemical' }),
    opt('Nitrite', POSNEG, 'Negative', { s: 'Chemical' }), opt('Leucocyte esterase', PLUS, 'Nil', { s: 'Chemical' }),
    txt('Pus cells', '0 – 5 /HPF', { s: 'Microscopy' }), txt('Red blood cells', '0 – 2 /HPF', { s: 'Microscopy' }),
    txt('Epithelial cells', 'Few', { s: 'Microscopy' }), txt('Casts', 'Nil', { s: 'Microscopy' }),
    txt('Crystals', 'Nil', { s: 'Microscopy' }), txt('Bacteria', 'Nil', { s: 'Microscopy' }),
    txt('Others', '', { s: 'Microscopy' })], { prep: 'First morning, mid-stream urine in the lab container.' }),
  T('UPT', 'Urine Pregnancy Test', CP, 'Urine', 'Sterile container', 1, [opt('Urine β-hCG', POSNEG)],
    { prep: 'First morning urine gives the most reliable result.' }),
  T('SRE', 'Stool Routine Examination', CP, 'Stool', 'Stool container', 3, [
    opt('Colour', 'Brown,Yellow,Green,Black,Clay,Red', 'Brown', { s: 'Physical' }),
    opt('Consistency', 'Formed,Semi-formed,Loose,Watery,Mucoid', 'Formed', { s: 'Physical' }),
    opt('Mucus', 'Absent,Present', 'Absent', { s: 'Physical' }), opt('Blood', 'Absent,Present', 'Absent', { s: 'Physical' }),
    txt('Pus cells', 'Nil', { s: 'Microscopy' }), txt('Red blood cells', 'Nil', { s: 'Microscopy' }),
    txt('Ova', 'Not seen', { s: 'Microscopy' }), txt('Cysts', 'Not seen', { s: 'Microscopy' }),
    txt('Trophozoites', 'Not seen', { s: 'Microscopy' }), txt('Others', '', { s: 'Microscopy' })]),
  T('FOB', 'Stool Occult Blood', CP, 'Stool', 'Stool container', 3, [opt('Occult blood', POSNEG, 'Negative')]),
  T('SEMEN', 'Semen Analysis', CP, 'Semen', 'Sterile container', 4, [
    num('Volume', 'mL', 1.4, null, { s: 'Physical' }), opt('Liquefaction', 'Complete within 60 min,Incomplete', 'Complete within 60 min', { s: 'Physical' }),
    num('pH', '', 7.2, 8.0, { s: 'Physical' }),
    num('Sperm concentration', 'million/mL', 16, null, { s: 'Sperm count', d: 0 }),
    num('Total sperm count', 'million/ejaculate', 39, null, { s: 'Sperm count', d: 0 }),
    num('Total motility (PR + NP)', '%', 42, null, { s: 'Motility', d: 0 }),
    num('Progressive motility (PR)', '%', 30, null, { s: 'Motility', d: 0 }),
    num('Non-progressive (NP)', '%', null, null, { s: 'Motility', d: 0 }),
    num('Immotile', '%', null, null, { s: 'Motility', d: 0 }),
    num('Normal forms', '%', 4, null, { s: 'Morphology', d: 0 }), num('Vitality', '%', 54, null, { s: 'Morphology', d: 0 }),
    txt('Pus cells', '', { s: 'Other cells' }), txt('Comment', '')],
    { prep: '2 to 7 days of abstinence. Collect the whole sample in the lab container and bring it within 30 minutes, kept at body temperature.', note: 'Lower reference limits: WHO laboratory manual (6th edition, 2021).', auto: false }),
  T('CSF', 'CSF Analysis', CP, 'CSF', 'Sterile container', 4, [
    txt('Appearance', 'Clear, colourless'), num('Total cells', '/µL', 0, 5, { d: 0 }), txt('Differential', ''),
    num('Protein', 'mg/dL', 15, 45, { d: 0 }), num('Glucose', 'mg/dL', 40, 70, { d: 0 }), txt('Gram stain', ''), txt('Comment', '')], { auto: false }),
  T('FLUID', 'Body Fluid Analysis (Pleural / Ascitic)', CP, 'Body fluid', 'Sterile container', 6, [
    txt('Type of fluid', ''), txt('Appearance', ''), num('Total cells', '/µL', null, null, { d: 0 }), txt('Differential', ''),
    num('Protein', 'g/dL', null, null), num('Glucose', 'mg/dL', null, null, { d: 0 }), num('LDH', 'U/L', null, null, { d: 0 }),
    txt('Comment', '')], { auto: false }),

  // ============================ Microbiology ===========================
  T('UCS', 'Urine Culture & Sensitivity', MICRO, 'Urine', 'Sterile container', 72, [], { kind: 'culture', prep: BEFORE_AB + ' Mid-stream urine.', auto: false }),
  T('BCS', 'Blood Culture & Sensitivity', MICRO, 'Blood', 'Blood culture bottle', 120, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('PCS', 'Pus / Wound Culture & Sensitivity', MICRO, 'Pus / swab', 'Sterile swab', 72, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('SCS', 'Stool Culture & Sensitivity', MICRO, 'Stool', 'Stool container', 72, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('SPCS', 'Sputum Culture & Sensitivity', MICRO, 'Sputum', 'Sterile container', 72, [], { kind: 'culture', prep: BEFORE_AB + ' Early-morning deep cough sputum, not saliva.', auto: false }),
  T('HVS', 'High Vaginal Swab Culture & Sensitivity', MICRO, 'HVS', 'Sterile swab', 72, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('TSCS', 'Throat Swab Culture & Sensitivity', MICRO, 'Throat swab', 'Sterile swab', 72, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('FCS', 'Fluid Culture & Sensitivity', MICRO, 'Body fluid', 'Sterile container', 72, [], { kind: 'culture', prep: BEFORE_AB, auto: false }),
  T('GRAM', 'Gram Stain', MICRO, 'As sent', 'Sterile container', 2, [txt('Gram stain', '')], { auto: false }),
  T('AFB', 'AFB Smear (ZN Stain)', MICRO, 'Sputum', 'Sterile container', 24, [
    opt('Acid-fast bacilli', 'Not seen,Scanty,1+,2+,3+', 'Not seen')], { prep: 'Two early-morning sputum samples on consecutive days.', auto: false }),
  T('KOH', 'KOH Mount (Fungus)', MICRO, 'Skin / nail / hair', 'Sterile container', 4, [opt('Fungal elements', 'Not seen,Seen', 'Not seen'), txt('Comment', '')]),
  T('GENEX', 'GeneXpert MTB/RIF', MOL, 'Sputum', 'Sterile container', 48, [
    opt('MTB', 'Not detected,Detected (very low),Detected (low),Detected (medium),Detected (high)', 'Not detected'),
    opt('Rifampicin resistance', 'Not detected,Detected,Indeterminate', '')], { auto: false }),
  T('HCVPCR', 'HCV RNA PCR (Quantitative)', MOL, 'Plasma', 'EDTA (purple)', 96, [
    txt('HCV RNA', 'Not detected'), num('Viral load', 'IU/mL', null, null, { d: 0 })], { auto: false }),
  T('HBVPCR', 'HBV DNA PCR (Quantitative)', MOL, 'Plasma', 'EDTA (purple)', 96, [
    txt('HBV DNA', 'Not detected'), num('Viral load', 'IU/mL', null, null, { d: 0 })], { auto: false }),

  // ============================ Histopathology & Cytology =============
  T('HISTS', 'Histopathology (Small Biopsy)', HISTO, 'Tissue in formalin', 'Formalin container', 120, [], { kind: 'text', auto: false }),
  T('HISTL', 'Histopathology (Large Specimen)', HISTO, 'Tissue in formalin', 'Formalin container', 168, [], { kind: 'text', auto: false }),
  T('PAP', 'Pap Smear (Cervical Cytology)', HISTO, 'Cervical smear', 'Slide', 72, [], { kind: 'text', auto: false }),
  T('FNAC', 'FNAC', HISTO, 'Aspirate', 'Slides', 72, [], { kind: 'text', auto: false }),
  T('FCYTO', 'Fluid Cytology', HISTO, 'Body fluid', 'Sterile container', 72, [], { kind: 'text', auto: false }),

  // ============================ Blood bank =============================
  T('XM', 'Cross Match', BB, 'Whole blood', 'EDTA (purple)', 2, [
    txt('Donor bag / unit no.', ''), opt('Donor group', 'A+,A-,B+,B-,AB+,AB-,O+,O-'), opt('Cross match', 'Compatible,Incompatible', 'Compatible')], { auto: false }),
  T('DCT', 'Direct Coombs Test', BB, 'Whole blood', 'EDTA (purple)', 3, [opt('Direct Coombs (DAT)', POSNEG, 'Negative')]),
  T('ICT', 'Indirect Coombs Test', BB, 'Serum', 'Gel / Red', 4, [opt('Indirect Coombs (IAT)', POSNEG, 'Negative')]),
];

export const PACKAGES = [
  ['PKG-FULL', 'Full Body Checkup', ['CBC', 'ESR', 'LFT', 'RFT', 'LIPID', 'BSF', 'HBA1C', 'TSH', 'URE', 'VITD', 'B12']],
  ['PKG-DM', 'Diabetes Profile', ['BSF', 'HBA1C', 'RFT', 'LIPID', 'MALB', 'URE']],
  ['PKG-CARD', 'Cardiac Profile', ['LIPID', 'CKMB', 'TROPI', 'HSCRP']],
  ['PKG-FEVER', 'Fever Profile', ['CBC', 'MP', 'TYPHI', 'URE', 'CRP', 'DENGNS1']],
  ['PKG-PREOP', 'Pre-operative Profile', ['CBC', 'PT', 'APTT', 'BG', 'HBSAG', 'HCV', 'HIV', 'BSR', 'RFT']],
  ['PKG-ANC', 'Antenatal Profile', ['CBC', 'BG', 'HBSAG', 'HCV', 'HIV', 'VDRL', 'URE', 'BSR', 'TSH']],
  ['PKG-LIVER', 'Liver Profile', ['LFT', 'HBSAG', 'HCV', 'PT']],
  ['PKG-THY', 'Thyroid Complete', ['TFTF', 'ATPO']],
  ['PKG-ANEM', 'Anaemia Profile', ['CBC', 'RETIC', 'PS', 'IRON', 'B12', 'FOL']],
  ['PKG-FERT', 'Female Hormone Profile', ['LH', 'FSH', 'PRL', 'E2', 'TSH', 'AMH']],
];

export const ANTIBIOTICS = [
  ['Ampicillin', 'Penicillins'], ['Amoxicillin-clavulanate', 'Penicillins'], ['Piperacillin-tazobactam', 'Penicillins'],
  ['Cefazolin', 'Cephalosporins'], ['Cefuroxime', 'Cephalosporins'], ['Ceftriaxone', 'Cephalosporins'],
  ['Cefixime', 'Cephalosporins'], ['Ceftazidime', 'Cephalosporins'], ['Cefepime', 'Cephalosporins'],
  ['Cefoperazone-sulbactam', 'Cephalosporins'], ['Imipenem', 'Carbapenems'], ['Meropenem', 'Carbapenems'],
  ['Ertapenem', 'Carbapenems'], ['Aztreonam', 'Monobactams'], ['Gentamicin', 'Aminoglycosides'],
  ['Amikacin', 'Aminoglycosides'], ['Ciprofloxacin', 'Fluoroquinolones'], ['Levofloxacin', 'Fluoroquinolones'],
  ['Moxifloxacin', 'Fluoroquinolones'], ['Trimethoprim-sulfamethoxazole', 'Folate inhibitors'],
  ['Nitrofurantoin', 'Urinary agents'], ['Fosfomycin', 'Urinary agents'], ['Azithromycin', 'Macrolides'],
  ['Erythromycin', 'Macrolides'], ['Clarithromycin', 'Macrolides'], ['Clindamycin', 'Lincosamides'],
  ['Doxycycline', 'Tetracyclines'], ['Tetracycline', 'Tetracyclines'], ['Minocycline', 'Tetracyclines'],
  ['Tigecycline', 'Glycylcyclines'], ['Vancomycin', 'Glycopeptides'], ['Teicoplanin', 'Glycopeptides'],
  ['Linezolid', 'Oxazolidinones'], ['Oxacillin / Cefoxitin (MRSA screen)', 'Penicillins'], ['Penicillin', 'Penicillins'],
  ['Colistin', 'Polymyxins'], ['Polymyxin B', 'Polymyxins'], ['Chloramphenicol', 'Phenicols'],
  ['Fusidic acid', 'Others'], ['Rifampicin', 'Others'], ['Metronidazole', 'Nitroimidazoles'],
];

export const TEMPLATES = [
  ['Histopathology — standard', 'SPECIMEN:\n\nCLINICAL DETAILS:\n\nGROSS DESCRIPTION:\n\nMICROSCOPIC DESCRIPTION:\n\nDIAGNOSIS:\n\nCOMMENT:\n'],
  ['Pap smear (Bethesda)', 'SPECIMEN ADEQUACY: Satisfactory for evaluation; endocervical/transformation zone component present.\n\nGENERAL CATEGORISATION: Negative for intraepithelial lesion or malignancy.\n\nINTERPRETATION / RESULT:\n\nCOMMENT:\n'],
  ['FNAC — standard', 'SITE:\n\nCLINICAL DETAILS:\n\nASPIRATE:\n\nMICROSCOPY:\n\nDIAGNOSIS:\n'],
  ['Fluid cytology', 'FLUID TYPE:\n\nGROSS:\n\nMICROSCOPY:\n\nIMPRESSION: Negative for malignant cells.\n'],
  ['Peripheral smear comment', 'RBC: \nWBC: \nPlatelets: \nImpression: \n'],
];
