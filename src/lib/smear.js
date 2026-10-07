// Quick entry helpers for the CBC-with-smear report: RBC morphology is marked
// with taps (+ / ++ / +++) and a tap on a ready-made impression fills the
// Opinion and Advices.
export const MORPH_OPTS = '+,++,+++';
export const isMorph = (p) => p?.result_type === 'option' && String(p.options || '').replace(/\s/g, '') === MORPH_OPTS;
export const nextMorph = (v) => ({ '': '+', '+': '++', '++': '+++', '+++': '' })[v || ''] ?? '+';

export const SMEAR_PRESETS = [
  { label: 'Normal blood picture', opinion: 'Normal blood picture.', advices: ['Correlate clinically.'], morph: [] },
  { label: 'Iron deficiency', opinion: 'Hypochromic microcytic anaemia, suggestive of iron deficiency.',
    advices: ['Correlate clinically.', 'Serum Ferritin, Iron and TIBC.', 'Hb Electrophoresis / HPLC (to exclude thalassaemia trait).'], morph: ['Hypochromia', 'Microcytosis', 'Anisocytosis'] },
  { label: 'Megaloblastic', opinion: 'Macrocytic anaemia, megaloblastic picture suggested.',
    advices: ['Serum Vitamin B12 and Folate.', 'Correlate clinically.'], morph: ['Macrocytosis', 'Anisocytosis'] },
  { label: 'Bacterial infection', opinion: 'Neutrophilic leucocytosis, suggestive of bacterial infection.',
    advices: ['Correlate clinically.', 'CRP and culture as clinically indicated.'], morph: [] },
  { label: 'Viral infection', opinion: 'Relative lymphocytosis, suggestive of viral infection.',
    advices: ['Correlate clinically.'], morph: [] },
  { label: 'Eosinophilia', opinion: 'Eosinophilia.',
    advices: ['Correlate clinically.', 'Stool examination for ova and parasites.', 'Serum IgE as clinically indicated.'], morph: [] },
  { label: 'Low platelets', opinion: 'Thrombocytopenia (platelets reduced on smear).',
    advices: ['Repeat CBC to exclude platelet clumping.', 'Dengue NS1 / IgM if febrile.', 'Correlate clinically.'], morph: [] },
  { label: 'Pancytopenia', opinion: 'Pancytopenia.',
    advices: ['Correlate clinically.', 'Bone marrow examination if clinically indicated.'], morph: [] },
];
export const numbered = (list) => list.map((x, i) => `${i + 1}. ${x}`).join('\n');
