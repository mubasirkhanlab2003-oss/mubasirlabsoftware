// Starter PAEDIATRIC reference ranges (newborn, infant, child, adolescent).
// Same caution as the adult values: common textbook figures, to be confirmed
// for the lab's own analyser/kit. Adult ranges (18y+) live in catalogue.mjs.
// Format per band: [fromDays, toDays, gender|null, low, high, textOnly?]
const NB = [0, 30], INF = [30, 365], CH = [365, 4380], AD = [4380, 6570];
const b = (age, lo, hi, g = null, x = null) => [age[0], age[1], g, lo, hi, x];

export const PEDS = {
  'Haemoglobin': [b(NB, 14, 22), b(INF, 10, 13.5), b(CH, 11.5, 14.5), b(AD, 13, 16, 'male'), b(AD, 12, 15, 'female')],
  'RBC count': [b(NB, 4.0, 6.6), b(INF, 3.5, 5.1), b(CH, 4.0, 5.2), b(AD, 4.3, 5.5, 'male'), b(AD, 3.9, 5.0, 'female')],
  'Haematocrit (HCT)': [b(NB, 42, 65), b(INF, 30, 42), b(CH, 34, 43), b(AD, 37, 49, 'male'), b(AD, 35, 45, 'female')],
  'MCV': [b(NB, 95, 121), b(INF, 70, 90), b(CH, 75, 87), b(AD, 78, 96)],
  'MCH': [b(NB, 31, 37), b(INF, 23, 31), b(CH, 24, 30), b(AD, 25, 33)],
  'MCHC': [b(NB, 30, 36), b(INF, 29, 37), b(CH, 31, 37), b(AD, 31, 36)],
  'Total WBC count': [b(NB, 9, 30), b(INF, 6, 17.5), b(CH, 5, 15), b(AD, 4.5, 13.5)],
  'Neutrophils': [b(INF, 20, 45), b(CH, 30, 60), b(AD, 40, 70)],
  'Lymphocytes': [b(INF, 45, 75), b(CH, 30, 55), b(AD, 25, 45)],
  'Platelet count': [b(NB, 150, 450), b(INF, 150, 450), b(CH, 150, 450), b(AD, 150, 450)],
  'ESR (1st hour)': [b(NB, 0, 2), b(INF, 0, 10), b(CH, 0, 10), b(AD, 0, 15)],
  'Alkaline phosphatase': [b(NB, 75, 320), b(INF, 80, 400), b(CH, 100, 350), b(AD, 80, 400)],
  'Creatinine': [b(NB, 0.3, 1.0), b(INF, 0.2, 0.4), b(CH, 0.3, 0.7), b(AD, 0.5, 1.0)],
  'Urea': [b(NB, 10, 40), b(INF, 10, 36), b(CH, 12, 38), b(AD, 15, 40)],
  'Calcium': [b(NB, 7.6, 10.4), b(INF, 9.0, 11.0), b(CH, 8.8, 10.8), b(AD, 8.4, 10.2)],
  'Phosphorus': [b(NB, 4.8, 8.2), b(INF, 4.5, 6.7), b(CH, 3.9, 6.5), b(AD, 3.0, 5.4)],
  'Total bilirubin': [b(NB, null, null, null, 'Newborn: interpret by age in hours/days (neonatal chart)'), b(INF, 0.2, 1.0), b(CH, 0.2, 1.0), b(AD, 0.3, 1.2)],
  'Direct bilirubin': [b(NB, 0, 0.6), b(INF, 0, 0.3), b(CH, 0, 0.3), b(AD, 0, 0.3)],
  'Fasting blood glucose': [b(NB, 40, 90), b(INF, 60, 100), b(CH, 70, 100), b(AD, 70, 100)],
  'Random blood glucose': [b(NB, 40, 90), b(INF, 60, 140), b(CH, 70, 140), b(AD, 70, 140)],
  'TSH': [b(NB, null, null, null, 'Newborn: use age-specific chart for your method'), b(INF, 0.8, 8.2), b(CH, 0.7, 6.0), b(AD, 0.5, 5.0)],
  'Free T4': [b(NB, null, null, null, 'Newborn: use age-specific chart for your method'), b(INF, 0.9, 2.3), b(CH, 0.8, 2.0), b(AD, 0.8, 1.9)],
};
