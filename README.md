# Laboratory Information System

A complete lab system for one laboratory, run by one person or a full team.
React app that works offline + Supabase (PostgreSQL, sign-in, row level security). Deploys GitHub → Vercel → Supabase.

## What it does

**One patient, one master profile.** Every visit is one *case* under that profile, and the case **is the bill** — choose tests and the bill makes itself; add or cancel a test later and the same bill updates.

| Area | What you get |
| --- | --- |
| Registration | One screen: patient (search or new), referring doctor, panel/company, urgent/routine, home collection, tests by code or name, packages, discount (Rs or %), discount cards, payment. Patient instructions (fasting etc.) shown and printed. |
| Samples | One barcode per tube (tests on the same tube share it), label printing (size set in Settings), reject with reason → test goes back to "sample pending", storage place, discard date. |
| Results | Fast grid (Enter moves down), calculated values (LDL, eGFR CKD-EPI 2021, A/G ratio, indirect bilirubin…), flags, critical values with call log, last result + delta check, reflex suggestions (e.g. TSH high → FT4), culture & sensitivity with S/I/R antibiotic grid, written reports with templates (histopathology, Pap, FNAC). |
| Verification | Save and verify in one click, verify many at once, optional auto-verification of normal results, amendment with reason and full history. |
| Reports | Professional A4 report with logo, QR code (authenticity check), pathologist name and signature, "amended" stamp, letterhead mode, cumulative report, PDF and WhatsApp. |
| Online | Patient portal (link + PIN on the receipt: all reports, PDF), doctor portal (own patients, reports, commission account), public report check by QR. |
| Doctors | Commission per doctor: normal rate, department rates, single-test rates (% or fixed). Calculated on each test automatically; moves when the doctor is changed; removed when a test/case is cancelled or deleted. Ledger with balance, payments to doctor, printable / WhatsApp statement — daily, weekly, monthly, any dates. |
| Panels | Company/insurance rates, credit billing, monthly statement, payments from the company. |
| Money | Bills list, unpaid list with WhatsApp reminder, cash book by method, day closing (expected vs counted cash), refunds, expenses, outside-lab charges, profit & loss. |
| Lab quality | Stock with lots and expiry (taken out automatically per test, first-expiry first), QC with Levey-Jennings chart and Westgard rules, equipment calibration/maintenance reminders, turnaround time. |
| Reports | Summary, test-wise, department-wise, doctor-wise, panel-wise, TAT, profit & loss, business analysis (this month vs last, busiest hours, top tests), critical calls. CSV export everywhere. |
| Safety | Nothing is ever hard-deleted: Recycle Bin with Restore, optional delete PIN, audit log of every change, roles (Admin, Receptionist, Technician, Pathologist, Accountant). |
| Offline | Keeps working without internet; syncs automatically. |

### Money rules (decided with the lab owner)

* **Revenue belongs to the day the case was registered.** If a test is cancelled later, the refund is counted on the case's own day, so that day's revenue and cash go down. It is marked *late* in Bills → Refunds & late changes so the difference from that day's drawer count is clear.
* **Deleting a case or a patient** removes its bill, payments and doctor commission from every figure. **Restore** brings everything back.
* Commission is worked out on the price after the patient's discount (changeable in Settings → Billing & workflow), and can be set to count only once the bill is fully paid.

## Setup

### 1. Supabase
1. Create a project at supabase.com (or use your existing one — see *Upgrading* below).
2. **SQL Editor → New query** → paste the whole of `final_supabase.sql` → **Run**. Safe to run again.
3. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up".
4. **Authentication → Users → Add user**: create your login (email + password, tick *Auto Confirm User*). The **first account becomes the Admin**.
5. **Authentication → URL Configuration**: set *Site URL* to your Vercel address.

### 2. GitHub → Vercel
1. Push this folder to a GitHub repository.
2. vercel.com → Add New → Project → import it (framework: Vite).
3. Environment variables: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (Supabase → Project Settings → API). Never use the `service_role` key.
4. Deploy.

### 3. First use
Sign in. The yellow *Finish setting up* box lists what is missing:
* **Settings → Lab details**: name, address, phone, logo, and the **web address of this app** (used in QR codes and WhatsApp links).
* **Settings → Tests & prices**: 153 tests and 10 packages are loaded **without prices** — type prices for the tests you do and switch off the rest. Reference ranges are starter adult values: check them for your analyser and tick *Reviewed*.
* **Settings → Pathologists**: name, qualification, signature photo.
* **Doctors**: add referring doctors and their commission.

## Upgrading from the old "Clinic & Lab" version
Run the new `final_supabase.sql` on the same Supabase project. It keeps the patients, copies old lab orders, results, bills and payments into the new tables once, and leaves the old clinic tables untouched (no longer used). On each computer, open the app once with internet.

## Try it without a server
`npm install` then `npm run demo` — opens the app with an in-browser imitation of the server and the full test catalogue (any email/password). Data is not saved on a server. Never deploy the demo.

## For developers
```bash
npm install
cp .env.example .env     # fill in the two values
npm run dev
npm test                 # money, commission, results, QC, end-to-end workflow + sync
npm run test:sql         # runs final_supabase.sql on a real PostgreSQL (fresh + upgrade) and checks the rules
npm run sql              # rebuilds final_supabase.sql from sql/schema.sql + sql/catalogue.mjs
npm run build
```

`final_supabase.sql` is generated — edit `sql/schema.sql` (tables, rules, portals) or `sql/catalogue.mjs` (tests, ranges, packages, antibiotics) and run `npm run sql`.
