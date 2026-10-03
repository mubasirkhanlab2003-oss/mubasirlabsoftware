-- =====================================================================
--  Laboratory Information System — final_supabase.sql
--  Supabase → SQL Editor → New query → paste this whole file → Run.
--  Safe to run again (idempotent). Safe on a database that was used with
--  the older "Clinic & Lab" version: old lab data is copied into the new
--  tables once, old clinic tables are left untouched (no longer used).
--
--  Design
--  * Every synced table has: id uuid (made on the device, so offline work
--    never collides), created_at, updated_at (server clock, used for
--    incremental sync), row_version (conflict detection), created_by,
--    updated_by.
--  * One patient = one master profile (MR number). Every time the patient
--    comes, one ACCESSION (case) is made under that profile. The accession
--    IS the bill: its tests are the bill lines, so the bill is always
--    created and updated automatically.
--  * Nothing is hard-deleted. Deleted records get deleted_at and go to the
--    Recycle Bin; reports leave them out; Restore brings them back.
--  * Cancelling a test reduces the revenue of the day the test was
--    registered (not the day it was cancelled).
--  * Numbers (MR1-00001, L1-00017 …) carry a device code so devices
--    working offline never produce the same number.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Row metadata trigger
-- ---------------------------------------------------------------------
create or replace function public.tg_row_meta() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at  := coalesce(new.created_at, now());
    new.updated_at  := now();
    new.row_version := 1;
    new.created_by  := coalesce(new.created_by, auth.uid());
    new.updated_by  := auth.uid();
  else
    new.id          := old.id;
    new.created_at  := old.created_at;
    new.created_by  := old.created_by;
    new.updated_at  := now();
    new.row_version := old.row_version + 1;
    new.updated_by  := auth.uid();
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 2. Users and devices
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'reception',
  active     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid
);
-- roles: admin (everything) · reception · technician · pathologist · accountant
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles drop constraint profiles_role_check;
  end if;
  update public.profiles set role = 'technician' where role = 'lab';
  alter table public.profiles add constraint profiles_role_check
    check (role in ('admin','reception','technician','pathologist','accountant'));
  alter table public.profiles alter column role set default 'reception';
end $$;
alter table public.profiles drop column if exists doctor_id;

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() = 'admin', false)
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.app_role() is not null
$$;
-- may change prices, rates, commission, settings
create or replace function public.can_manage() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.app_role() in ('admin','accountant'), false)
$$;

-- First account ever created = active Admin. Later accounts are inactive
-- until the Admin activates them and chooses their role.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare has_admin boolean;
begin
  lock table public.profiles in share row exclusive mode;
  select exists(select 1 from public.profiles where role = 'admin') into has_admin;
  insert into public.profiles (id, email, full_name, role, active)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          case when has_admin then 'reception' else 'admin' end,
          not has_admin)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.tg_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.role = 'admin' and old.active) and (new.role <> 'admin' or not new.active) then
    if not exists (select 1 from public.profiles where role = 'admin' and active and id <> old.id) then
      raise exception 'At least one active Admin account is required';
    end if;
  end if;
  new.id := old.id; new.email := old.email;
  return new;
end $$;

create table if not exists public.devices (
  id           uuid primary key,
  code         int generated always as identity unique,
  label        text,
  user_id      uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. Lab settings + pathologists
-- ---------------------------------------------------------------------
create table if not exists public.lab_settings (
  id                     int primary key default 1 check (id = 1),
  lab_name               text,
  tagline                text,
  logo                   text check (logo is null or length(logo) < 400000),
  address                text,
  phone                  text,
  whatsapp               text,
  email                  text,
  website                text,
  working_hours          text,
  currency               text not null default 'Rs',
  phone_country_code     text not null default '92',
  public_url             text,             -- address of this app, used in QR codes and links
  report_footer          text,
  receipt_footer         text,
  report_mode            text not null default 'full' check (report_mode in ('full','letterhead')),
  letterhead_top_mm      int not null default 45,
  letterhead_bottom_mm   int not null default 25,
  receipt_format         text not null default 'a4' check (receipt_format in ('a4','thermal')),
  label_width_mm         int not null default 50,
  label_height_mm        int not null default 25,
  commission_basis       text not null default 'net' check (commission_basis in ('gross','net')),
  commission_needs_payment boolean not null default false,
  report_needs_payment   boolean not null default false,
  auto_verify            boolean not null default false,
  home_charge            numeric(12,2) not null default 0,
  delete_pin             text,
  expense_categories     text[] not null default '{Rent,Electricity,Salaries,Reagents & kits,Consumables,Maintenance,Internet & phone,Other}',
  sample_keep_days       int not null default 7,
  backup_reminder_days   int not null default 7,
  setup_completed        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid
);
insert into public.lab_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.pathologists (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null check (length(trim(full_name)) > 0),
  qualification text,
  designation   text,
  signature     text check (signature is null or length(signature) < 300000),
  is_default    boolean not null default false,
  active        boolean not null default true,
  sort_order    int not null default 0
);

-- ---------------------------------------------------------------------
-- 6. Test catalogue
-- ---------------------------------------------------------------------
create table if not exists public.lab_tests (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  category        text,                     -- department
  sample_type     text not null default 'Blood',
  price           numeric(12,2) check (price is null or price >= 0),
  active          boolean not null default true,
  sort_order      int not null default 0,
  is_starter      boolean not null default false,
  ranges_reviewed boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid
);
create unique index if not exists lab_tests_name_uq on public.lab_tests (lower(name));
alter table public.lab_tests add column if not exists kind           text not null default 'test';
alter table public.lab_tests add column if not exists components     jsonb not null default '[]'::jsonb;
alter table public.lab_tests add column if not exists container      text;
alter table public.lab_tests add column if not exists result_kind    text not null default 'parameters';
alter table public.lab_tests add column if not exists tat_hours      int;
alter table public.lab_tests add column if not exists instructions   text;
alter table public.lab_tests add column if not exists method         text;
alter table public.lab_tests add column if not exists loinc          text;
alter table public.lab_tests add column if not exists report_note    text;
alter table public.lab_tests add column if not exists auto_verify    boolean not null default true;
alter table public.lab_tests add column if not exists outsourced     boolean not null default false;
alter table public.lab_tests add column if not exists outsource_lab_id uuid;
alter table public.lab_tests add column if not exists template_id    uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lab_tests_kind_check') then
    alter table public.lab_tests add constraint lab_tests_kind_check check (kind in ('test','package'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lab_tests_result_kind_check') then
    alter table public.lab_tests add constraint lab_tests_result_kind_check check (result_kind in ('parameters','culture','text'));
  end if;
end $$;

create table if not exists public.lab_parameters (
  id          uuid primary key default gen_random_uuid(),
  test_id     uuid not null references public.lab_tests(id) on delete cascade,
  name        text not null,
  unit        text,
  result_type text not null default 'numeric',
  options     text,
  decimals    int not null default 1 check (decimals between 0 and 4),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid
);
create unique index if not exists lab_parameters_uq on public.lab_parameters (test_id, lower(name));
alter table public.lab_parameters add column if not exists code          text;   -- used in formulas, e.g. {TC}
alter table public.lab_parameters add column if not exists formula       text;   -- calculated parameters
alter table public.lab_parameters add column if not exists critical_low  numeric;
alter table public.lab_parameters add column if not exists critical_high numeric;
alter table public.lab_parameters add column if not exists delta_pct     numeric; -- warn if changed more than this % from last result
alter table public.lab_parameters add column if not exists reflex        jsonb;   -- {"when":"high","test":"FT4"}
alter table public.lab_parameters add column if not exists section       text;    -- sub-heading on report (e.g. "Differential count")
alter table public.lab_parameters add column if not exists default_value text;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'lab_parameters_result_type_check') then
    alter table public.lab_parameters drop constraint lab_parameters_result_type_check;
  end if;
  alter table public.lab_parameters add constraint lab_parameters_result_type_check
    check (result_type in ('numeric','text','option','calculated'));
end $$;

create table if not exists public.lab_reference_ranges (
  id           uuid primary key default gen_random_uuid(),
  parameter_id uuid not null references public.lab_parameters(id) on delete cascade,
  gender       text not null default 'any' check (gender in ('any','male','female')),
  age_min_days int not null default 0 check (age_min_days >= 0),
  age_max_days int check (age_max_days is null or age_max_days > age_min_days),
  low          numeric,
  high         numeric,
  display_text text,
  note         text,
  active       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid,
  check (low is null or high is null or low <= high)
);
create index if not exists lab_ranges_param_idx on public.lab_reference_ranges (parameter_id);

create table if not exists public.antibiotics (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  class      text,
  sort_order int not null default 0,
  active     boolean not null default true
);
create unique index if not exists antibiotics_name_uq on public.antibiotics (lower(name));

create table if not exists public.report_templates (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  body    text not null default '',
  active  boolean not null default true
);
create unique index if not exists report_templates_name_uq on public.report_templates (lower(name));

-- ---------------------------------------------------------------------
-- 4. Referring doctors, panels, memberships
-- ---------------------------------------------------------------------
create table if not exists public.ref_doctors (
  id                     uuid primary key default gen_random_uuid(),
  full_name              text not null check (length(trim(full_name)) > 0),
  qualification          text,
  hospital               text,
  phone                  text,
  notes                  text,
  rate_type              text not null default 'percent' check (rate_type in ('percent','fixed')),
  rate_value             numeric(12,2) not null default 0 check (rate_value >= 0),
  portal_enabled         boolean not null default false,
  portal_token           text unique,
  portal_pin             text,
  portal_show_commission boolean not null default true,
  active                 boolean not null default true,
  deleted_at             timestamptz,
  delete_reason          text
);

-- Commission overrides: a department rate, or a single-test rate.
-- Most specific wins: test → department → doctor default.
create table if not exists public.commission_rules (
  id         uuid primary key default gen_random_uuid(),
  doctor_id  uuid not null references public.ref_doctors(id),
  scope      text not null check (scope in ('department','test')),
  department text,
  test_id    uuid references public.lab_tests(id),
  rate_type  text not null default 'percent' check (rate_type in ('percent','fixed')),
  rate_value numeric(12,2) not null default 0 check (rate_value >= 0),
  active     boolean not null default true,
  check ((scope = 'department' and department is not null) or (scope = 'test' and test_id is not null))
);

create table if not exists public.doctor_payouts (
  id            uuid primary key default gen_random_uuid(),
  payout_number text unique,
  doctor_id     uuid not null references public.ref_doctors(id),
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'cash',
  paid_on       date not null default current_date,
  reference     text,
  note          text,
  deleted_at    timestamptz,
  delete_reason text
);

create table if not exists public.panels (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) > 0),
  kind         text not null default 'corporate' check (kind in ('corporate','insurance','other')),
  contact      text,
  phone        text,
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  credit       boolean not null default true,     -- billed to the company monthly
  notes        text,
  active       boolean not null default true
);
create table if not exists public.panel_rates (
  id       uuid primary key default gen_random_uuid(),
  panel_id uuid not null references public.panels(id),
  test_id  uuid not null references public.lab_tests(id),
  price    numeric(12,2) not null check (price >= 0)
);
create table if not exists public.panel_payments (
  id            uuid primary key default gen_random_uuid(),
  panel_id      uuid not null references public.panels(id),
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'bank_transfer',
  paid_on       date not null default current_date,
  reference     text,
  note          text,
  deleted_at    timestamptz,
  delete_reason text
);

create table if not exists public.memberships (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100),
  active       boolean not null default true
);

-- ---------------------------------------------------------------------
-- 5. Master patient
-- ---------------------------------------------------------------------
create table if not exists public.patients (
  id            uuid primary key default gen_random_uuid(),
  mr_number     text not null unique,
  full_name     text not null check (length(trim(full_name)) > 0),
  phone         text,
  dob           date,
  dob_estimated boolean not null default false,
  gender        text check (gender in ('male','female','other')),
  address       text,
  deleted_at    timestamptz,
  delete_reason text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  row_version int not null default 1,
  created_by  uuid,
  updated_by  uuid
);
alter table public.patients add column if not exists title          text;
alter table public.patients add column if not exists cnic           text;
alter table public.patients add column if not exists email          text;
alter table public.patients add column if not exists guardian       text;
alter table public.patients add column if not exists notes          text;
alter table public.patients add column if not exists membership_id  uuid references public.memberships(id);
alter table public.patients add column if not exists membership_no  text;
alter table public.patients add column if not exists membership_until date;
alter table public.patients add column if not exists portal_token   text;
alter table public.patients add column if not exists portal_pin     text;
alter table public.patients add column if not exists merged_into    uuid references public.patients(id);
alter table public.patients add column if not exists deleted_batch  uuid;
create unique index if not exists patients_portal_uq on public.patients (portal_token) where portal_token is not null;
create index if not exists patients_name_idx  on public.patients (lower(full_name));
create index if not exists patients_phone_idx on public.patients (phone);
create index if not exists patients_cnic_idx  on public.patients (cnic);
-- old clinic columns that must not block lab registrations
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='patients' and column_name='registered_from') then
    alter table public.patients alter column registered_from set default 'lab';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. Outsourcing
-- ---------------------------------------------------------------------
create table if not exists public.outsource_labs (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  phone   text,
  address text,
  active  boolean not null default true
);
create table if not exists public.outsource_rates (
  id      uuid primary key default gen_random_uuid(),
  lab_id  uuid not null references public.outsource_labs(id),
  test_id uuid not null references public.lab_tests(id),
  cost    numeric(12,2) not null check (cost >= 0)
);
create table if not exists public.outsource_payments (
  id            uuid primary key default gen_random_uuid(),
  lab_id        uuid not null references public.outsource_labs(id),
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'cash',
  paid_on       date not null default current_date,
  note          text,
  deleted_at    timestamptz,
  delete_reason text
);

-- ---------------------------------------------------------------------
-- 8. Accession (one patient visit to the lab = one bill)
-- ---------------------------------------------------------------------
create table if not exists public.accessions (
  id              uuid primary key default gen_random_uuid(),
  acc_number      text not null unique,
  patient_id      uuid not null references public.patients(id),
  reg_date        date not null default current_date,
  registered_at   timestamptz not null default now(),
  doctor_id       uuid references public.ref_doctors(id),
  doctor_text     text,                      -- "Self" or a name not in the list
  panel_id        uuid references public.panels(id),
  bill_to         text not null default 'patient' check (bill_to in ('patient','panel')),
  priority        text not null default 'routine' check (priority in ('routine','urgent')),
  home_collection boolean not null default false,
  home_address    text,
  home_time       timestamptz,
  home_status     text check (home_status in ('scheduled','collected','cancelled')),
  home_charge     numeric(12,2) not null default 0 check (home_charge >= 0),
  discount        numeric(12,2) not null default 0 check (discount >= 0),
  discount_reason text,
  clinical_notes  text,
  report_due_at   timestamptz,
  verify_code     text unique,
  deleted_at      timestamptz,
  delete_reason   text,
  deleted_batch   uuid
);
create index if not exists accessions_patient_idx on public.accessions (patient_id);
create index if not exists accessions_date_idx    on public.accessions (reg_date);
create index if not exists accessions_doctor_idx  on public.accessions (doctor_id);

create table if not exists public.specimens (
  id              uuid primary key default gen_random_uuid(),
  specimen_number text not null unique,     -- printed as barcode
  accession_id    uuid not null references public.accessions(id),
  sample_type     text not null,
  container       text,
  status          text not null default 'collected' check (status in ('collected','rejected','discarded')),
  collected_at    timestamptz,
  reject_reason   text,
  rejected_at     timestamptz,
  storage         text,
  discard_after   date,
  discarded_at    timestamptz
);
create index if not exists specimens_acc_idx on public.specimens (accession_id);

create table if not exists public.accession_tests (
  id               uuid primary key default gen_random_uuid(),
  accession_id     uuid not null references public.accessions(id),
  patient_id       uuid references public.patients(id),
  test_id          uuid not null references public.lab_tests(id),
  test_code        text,
  test_name        text not null,
  department       text,
  sample_type      text,
  package_id       uuid references public.lab_tests(id),
  list_price       numeric(12,2) not null default 0,
  price            numeric(12,2) not null default 0 check (price >= 0),
  commission       numeric(12,2) not null default 0,
  commission_note  text,
  status           text not null default 'pending'
                   check (status in ('pending','collected','entered','verified','cancelled')),
  specimen_id      uuid references public.specimens(id),
  results          jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  culture          jsonb,
  text_result      text,
  remarks          text,
  entered_at       timestamptz,
  entered_by       uuid,
  verified_at      timestamptz,
  verified_by      uuid,
  pathologist_id   uuid references public.pathologists(id),
  auto_verified    boolean not null default false,
  amend_count      int not null default 0,
  due_at           timestamptz,
  outsource_lab_id uuid references public.outsource_labs(id),
  outsource_cost   numeric(12,2),
  outsource_sent_at timestamptz,
  lots             jsonb,
  cancelled_at     timestamptz,
  cancel_reason    text,
  sort_order       int not null default 0
);
create unique index if not exists acc_tests_no_dup
  on public.accession_tests (accession_id, test_id) where status <> 'cancelled';
create index if not exists acc_tests_acc_idx     on public.accession_tests (accession_id);
create index if not exists acc_tests_patient_idx on public.accession_tests (patient_id);

create table if not exists public.result_amendments (
  id                uuid primary key default gen_random_uuid(),
  accession_test_id uuid not null references public.accession_tests(id),
  reason            text not null check (length(trim(reason)) > 0),
  old_data          jsonb not null,
  new_data          jsonb not null,
  amended_at        timestamptz not null default now()
);

create table if not exists public.critical_calls (
  id                uuid primary key default gen_random_uuid(),
  accession_test_id uuid not null references public.accession_tests(id),
  accession_id      uuid not null references public.accessions(id),
  parameter         text,
  value             text,
  informed_to       text not null,
  informed_at       timestamptz not null default now(),
  note              text
);

create table if not exists public.bill_payments (
  id             uuid primary key default gen_random_uuid(),
  payment_number text not null unique,
  accession_id   uuid not null references public.accessions(id),
  patient_id     uuid references public.patients(id),
  kind           text not null default 'payment' check (kind in ('payment','refund')),
  amount         numeric(12,2) not null,
  method         text not null default 'cash',
  reference      text,
  business_date  date not null default current_date,   -- the day this money counts in
  received_at    timestamptz not null default now(),
  note           text,
  late_adjustment boolean not null default false,       -- made after that day had passed
  deleted_at     timestamptz,
  delete_reason  text,
  check ((kind = 'payment' and amount > 0) or (kind = 'refund' and amount < 0))
);
create index if not exists bill_payments_acc_idx  on public.bill_payments (accession_id);
create index if not exists bill_payments_date_idx on public.bill_payments (business_date);

create table if not exists public.print_log (
  id           uuid primary key default gen_random_uuid(),
  accession_id uuid references public.accessions(id),
  doc_type     text not null,
  via          text not null default 'print',
  printed_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 9. Money out, stock, quality
-- ---------------------------------------------------------------------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  exp_date      date not null default current_date,
  category      text not null,
  amount        numeric(12,2) not null check (amount > 0),
  method        text not null default 'cash',
  paid_to       text,
  note          text,
  deleted_at    timestamptz,
  delete_reason text
);
create index if not exists expenses_date_idx on public.expenses (exp_date);

create table if not exists public.day_closings (
  id            uuid primary key default gen_random_uuid(),
  close_date    date not null unique,
  expected_cash numeric(12,2) not null default 0,
  counted_cash  numeric(12,2),
  note          text,
  closed_at     timestamptz not null default now()
);

create table if not exists public.inv_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  unit          text not null default 'pcs',
  category      text,
  reorder_level numeric(12,2) not null default 0,
  notes         text,
  active        boolean not null default true
);
create table if not exists public.inv_lots (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references public.inv_items(id),
  lot_number   text,
  expiry       date,
  received_on  date not null default current_date,
  qty_received numeric(12,2) not null default 0,
  cost         numeric(12,2),
  supplier     text,
  active       boolean not null default true
);
create table if not exists public.inv_moves (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.inv_items(id),
  lot_id            uuid references public.inv_lots(id),
  qty               numeric(12,2) not null,      -- + in, − out
  kind              text not null check (kind in ('receive','consume','adjust','waste','return')),
  accession_test_id uuid references public.accession_tests(id),
  moved_at          timestamptz not null default now(),
  note              text
);
create index if not exists inv_moves_item_idx on public.inv_moves (item_id);
create table if not exists public.test_consumption (
  id      uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.lab_tests(id),
  item_id uuid not null references public.inv_items(id),
  qty     numeric(12,3) not null check (qty > 0)
);
alter table public.test_consumption add column if not exists active boolean not null default true;

create table if not exists public.qc_materials (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  parameter_id uuid references public.lab_parameters(id),
  level        text,
  lot_number   text,
  expiry       date,
  mean         numeric not null,
  sd           numeric not null check (sd > 0),
  unit         text,
  active       boolean not null default true
);
create table if not exists public.qc_runs (
  id          uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.qc_materials(id),
  run_at      timestamptz not null default now(),
  value       numeric not null,
  status      text not null default 'ok' check (status in ('ok','warning','reject')),
  rules       text,
  action      text,
  deleted_at  timestamptz
);
create index if not exists qc_runs_mat_idx on public.qc_runs (material_id);

create table if not exists public.equipment (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  model               text,
  serial_no           text,
  location            text,
  calib_interval_days int,
  maint_interval_days int,
  notes               text,
  active              boolean not null default true
);
create table if not exists public.equipment_logs (
  id           uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references public.equipment(id),
  kind         text not null check (kind in ('calibration','maintenance','breakdown','repair')),
  log_date     date not null default current_date,
  next_due     date,
  done_by      text,
  note         text
);

-- ---------------------------------------------------------------------
-- 10. Audit log + sync conflicts
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  record_id  text,
  action     text not null,
  changes    jsonb,
  user_id    uuid,
  at         timestamptz not null default now()
);
create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id);
create index if not exists audit_log_at_idx     on public.audit_log (at);

create table if not exists public.sync_conflicts (
  id          uuid primary key default gen_random_uuid(),
  table_name  text not null,
  record_id   uuid,
  local_data  jsonb,
  server_data jsonb,
  error       text,
  device_code int,
  user_id     uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution  text
);

-- ---------------------------------------------------------------------
-- 11. Common columns + triggers on every synced table
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['profiles','lab_settings','pathologists','ref_doctors','commission_rules',
    'doctor_payouts','panels','panel_rates','panel_payments','memberships','patients','lab_tests',
    'lab_parameters','lab_reference_ranges','antibiotics','report_templates','outsource_labs',
    'outsource_rates','outsource_payments','accessions','specimens','accession_tests',
    'result_amendments','critical_calls','bill_payments','print_log','expenses','day_closings',
    'inv_items','inv_lots','inv_moves','test_consumption','qc_materials','qc_runs','equipment',
    'equipment_logs']
  loop
    execute format('alter table public.%I add column if not exists created_at timestamptz not null default now()', t);
    execute format('alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('alter table public.%I add column if not exists row_version int not null default 1', t);
    execute format('alter table public.%I add column if not exists created_by uuid', t);
    execute format('alter table public.%I add column if not exists updated_by uuid', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_upd_idx', t);
    execute format('drop trigger if exists a_row_meta on public.%I', t);
    execute format('create trigger a_row_meta before insert or update on public.%I
                    for each row execute function public.tg_row_meta()', t);
  end loop;
end $$;

create or replace function public.tg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb; n jsonb; diff jsonb := '{}'::jsonb; k text;
  skip text[] := array['updated_at','row_version','updated_by','created_at','created_by'];
begin
  if tg_op = 'INSERT' then
    n := (to_jsonb(new) - skip) - 'logo' - 'signature';
    insert into public.audit_log (table_name, record_id, action, changes, user_id)
    values (tg_table_name, (to_jsonb(new)->>'id'), 'insert', n, auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    for k in select jsonb_object_keys(n) loop
      if k = any(skip) then continue; end if;
      if (o->k) is distinct from (n->k) then
        if k in ('logo','signature') then
          diff := diff || jsonb_build_object(k, jsonb_build_object('old','[image]','new','[image]'));
        else
          diff := diff || jsonb_build_object(k, jsonb_build_object('old', o->k, 'new', n->k));
        end if;
      end if;
    end loop;
    if diff <> '{}'::jsonb then
      insert into public.audit_log (table_name, record_id, action, changes, user_id)
      values (tg_table_name, (n->>'id'), 'update', diff, auth.uid());
    end if;
    return new;
  else
    insert into public.audit_log (table_name, record_id, action, changes, user_id)
    values (tg_table_name, (to_jsonb(old)->>'id'), 'delete', to_jsonb(old) - 'logo' - 'signature', auth.uid());
    return old;
  end if;
end $$;

create or replace function public.tg_block_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% records cannot be deleted permanently. Use Delete (Recycle Bin) instead.', tg_table_name;
end $$;

do $$
declare t text;
begin
  foreach t in array array['lab_settings','pathologists','ref_doctors','commission_rules','doctor_payouts',
    'panels','panel_rates','panel_payments','memberships','patients','lab_tests','lab_parameters',
    'lab_reference_ranges','accessions','specimens','accession_tests','result_amendments','critical_calls',
    'bill_payments','expenses','day_closings','inv_lots','inv_moves','test_consumption','qc_materials',
    'qc_runs','equipment_logs','outsource_rates','outsource_payments','profiles']
  loop
    execute format('drop trigger if exists z_audit on public.%I', t);
    execute format('create trigger z_audit after insert or update or delete on public.%I
                    for each row execute function public.tg_audit()', t);
  end loop;
  foreach t in array array['patients','accessions','accession_tests','bill_payments','specimens',
    'doctor_payouts','expenses','result_amendments','critical_calls','panel_payments','outsource_payments',
    'inv_moves','qc_runs']
  loop
    execute format('drop trigger if exists b_no_delete on public.%I', t);
    execute format('create trigger b_no_delete before delete on public.%I
                    for each row execute function public.tg_block_delete()', t);
  end loop;
end $$;

drop trigger if exists b_profiles_guard on public.profiles;
create trigger b_profiles_guard before update on public.profiles
  for each row execute function public.tg_profiles_guard();

-- ---------------------------------------------------------------------
-- 12. Business rules
-- ---------------------------------------------------------------------
-- Bill total of one accession (same rule as the app).
create or replace function public.acc_total(p_acc uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce((select sum(price) from public.accession_tests where accession_id = p_acc and status <> 'cancelled'), 0)
    + coalesce(a.home_charge, 0) - coalesce(a.discount, 0), 0)
  from public.accessions a where a.id = p_acc
$$;
create or replace function public.acc_paid(p_acc uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from public.bill_payments where accession_id = p_acc and deleted_at is null
$$;

-- A test always belongs to its accession's patient; verified results are
-- locked unless the change is an amendment (amend_count goes up).
create or replace function public.tg_acc_test_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select patient_id into new.patient_id from public.accessions where id = new.accession_id;
  if tg_op = 'UPDATE' then
    new.test_id := old.test_id;
    if old.status = 'verified' and new.amend_count = old.amend_count then
      if new.results is distinct from old.results or new.culture is distinct from old.culture
         or new.text_result is distinct from old.text_result or new.remarks is distinct from old.remarks then
        raise exception 'Result is verified and locked. Use "Amend" to correct it.';
      end if;
    end if;
    if new.amend_count < old.amend_count then new.amend_count := old.amend_count; end if;
  end if;
  return new;
end $$;
drop trigger if exists b_acc_test_guard on public.accession_tests;
create trigger b_acc_test_guard before insert or update on public.accession_tests
  for each row execute function public.tg_acc_test_guard();

create or replace function public.tg_payment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare tot numeric; paid numeric;
begin
  select patient_id into new.patient_id from public.accessions where id = new.accession_id;
  if new.kind = 'payment' and new.deleted_at is null then
    tot := public.acc_total(new.accession_id);
    select coalesce(sum(amount), 0) into paid from public.bill_payments
     where accession_id = new.accession_id and deleted_at is null and id <> new.id;
    if paid + new.amount > tot + 0.01 then
      raise exception 'Payment is more than the amount due on this bill';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists b_payment_guard on public.bill_payments;
create trigger b_payment_guard before insert or update on public.bill_payments
  for each row execute function public.tg_payment_guard();

-- ---------------------------------------------------------------------
-- 13. Functions used by the app
-- ---------------------------------------------------------------------
create or replace function public.register_device(p_id uuid, p_label text)
returns int language plpgsql security definer set search_path = public as $$
declare c int;
begin
  if not public.is_staff() then raise exception 'Not authorised'; end if;
  insert into public.devices (id, label, user_id) values (p_id, p_label, auth.uid())
  on conflict (id) do update set last_seen_at = now(), user_id = auth.uid()
  returning code into c;
  return c;
end $$;

create or replace function public.device_max_numbers(p_code int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb := '{}'::jsonb; v int;
begin
  if not public.is_staff() then raise exception 'Not authorised'; end if;
  select max(split_part(mr_number,'-',2)::int) into v from public.patients where mr_number like 'MR'||p_code||'-%';
  r := r || jsonb_build_object('MR', coalesce(v,0));
  select max(split_part(acc_number,'-',2)::int) into v from public.accessions where acc_number like 'L'||p_code||'-%';
  r := r || jsonb_build_object('L', coalesce(v,0));
  select max(split_part(specimen_number,'-',2)::int) into v from public.specimens where specimen_number like 'S'||p_code||'-%';
  r := r || jsonb_build_object('S', coalesce(v,0));
  select max(split_part(payment_number,'-',2)::int) into v from public.bill_payments where payment_number like 'R'||p_code||'-%';
  r := r || jsonb_build_object('R', coalesce(v,0));
  select max(split_part(payout_number,'-',2)::int) into v from public.doctor_payouts where payout_number like 'DP'||p_code||'-%';
  r := r || jsonb_build_object('DP', coalesce(v,0));
  return r;
end $$;

-- Lab header block shared by the portals
create or replace function public._portal_lab() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'lab_name', s.lab_name, 'tagline', s.tagline, 'logo', s.logo, 'address', s.address, 'phone', s.phone,
    'whatsapp', s.whatsapp, 'email', s.email, 'website', s.website, 'currency', s.currency,
    'report_footer', s.report_footer, 'public_url', s.public_url,
    'pathologists', coalesce((select jsonb_agg(to_jsonb(p) - 'created_by' - 'updated_by' order by p.sort_order)
                               from public.pathologists p where p.active), '[]'::jsonb))
  from public.lab_settings s where s.id = 1
$$;

-- One accession as a report object (only verified tests carry results)
create or replace function public._portal_case(p_acc uuid, p_show_results boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', a.id, 'acc_number', a.acc_number, 'reg_date', a.reg_date, 'registered_at', a.registered_at,
    'verify_code', a.verify_code, 'priority', a.priority,
    'doctor', coalesce(d.full_name, a.doctor_text),
    'total', public.acc_total(a.id), 'paid', public.acc_paid(a.id),
    'due', case when a.bill_to = 'panel' then 0 else public.acc_total(a.id) - public.acc_paid(a.id) end,
    'tests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'test_id', t.test_id, 'test_name', t.test_name, 'test_code', t.test_code,
        'department', t.department, 'sample_type', t.sample_type, 'status', t.status,
        'verified_at', t.verified_at, 'entered_at', t.entered_at, 'amended', t.amend_count > 0,
        'pathologist_id', t.pathologist_id, 'report_note', lt.report_note, 'method', lt.method,
        'results',     case when p_show_results and t.status = 'verified' then t.results end,
        'culture',     case when p_show_results and t.status = 'verified' then t.culture end,
        'text_result', case when p_show_results and t.status = 'verified' then t.text_result end,
        'remarks',     case when p_show_results and t.status = 'verified' then t.remarks end
      ) order by t.department, t.sort_order)
      from public.accession_tests t left join public.lab_tests lt on lt.id = t.test_id
      where t.accession_id = a.id and t.status <> 'cancelled'), '[]'::jsonb))
  from public.accessions a left join public.ref_doctors d on d.id = a.doctor_id
  where a.id = p_acc
$$;

-- Patient portal: secret link + PIN → all of the patient's reports
create or replace function public.portal_patient(p_token text, p_pin text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare pt record; needs_pay boolean; cases jsonb := '[]'::jsonb; a record; c jsonb;
begin
  if p_token is null or length(p_token) < 16 then return jsonb_build_object('error','invalid'); end if;
  select * into pt from public.patients
   where portal_token = p_token and deleted_at is null and merged_into is null;
  if pt.id is null or coalesce(pt.portal_pin,'') <> coalesce(p_pin,'') then
    return jsonb_build_object('error','invalid');
  end if;
  select report_needs_payment into needs_pay from public.lab_settings where id = 1;
  for a in select * from public.accessions where patient_id = pt.id and deleted_at is null order by registered_at desc loop
    c := public._portal_case(a.id, true);
    if needs_pay and a.bill_to = 'patient' and (c->>'due')::numeric > 0.009 then
      c := public._portal_case(a.id, false) || jsonb_build_object('locked', true);
    end if;
    cases := cases || jsonb_build_array(c);
  end loop;
  return jsonb_build_object(
    'lab', public._portal_lab(),
    'patient', jsonb_build_object('full_name', pt.full_name, 'mr_number', pt.mr_number, 'gender', pt.gender,
                                  'dob', pt.dob, 'dob_estimated', pt.dob_estimated, 'phone', pt.phone),
    'cases', cases);
end $$;

-- Referring-doctor portal: secret link + PIN → own patients + own account
create or replace function public.portal_doctor(p_token text, p_pin text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d record; s record; rows jsonb; pays jsonb; earned numeric; paid numeric;
begin
  if p_token is null or length(p_token) < 16 then return jsonb_build_object('error','invalid'); end if;
  select * into d from public.ref_doctors
   where portal_token = p_token and portal_enabled and active and deleted_at is null;
  if d.id is null or coalesce(d.portal_pin,'') <> coalesce(p_pin,'') then
    return jsonb_build_object('error','invalid');
  end if;
  select * into s from public.lab_settings where id = 1;

  select coalesce(jsonb_agg(x order by x->>'registered_at' desc), '[]'::jsonb) into rows from (
    select public._portal_case(a.id, true)
      || jsonb_build_object('patient', jsonb_build_object('full_name', p.full_name, 'mr_number', p.mr_number,
                                       'gender', p.gender, 'dob', p.dob, 'dob_estimated', p.dob_estimated),
                            'commission', case when d.portal_show_commission then
                               (select coalesce(sum(t.commission),0) from public.accession_tests t
                                 where t.accession_id = a.id and t.status <> 'cancelled') end) as x
    from public.accessions a join public.patients p on p.id = a.patient_id
    where a.doctor_id = d.id and a.deleted_at is null and a.reg_date between p_from and p_to) q;

  if d.portal_show_commission then
    select coalesce(sum(t.commission),0) into earned
      from public.accession_tests t join public.accessions a on a.id = t.accession_id
     where a.doctor_id = d.id and a.deleted_at is null and t.status <> 'cancelled'
       and (not s.commission_needs_payment or a.bill_to = 'panel'
            or public.acc_paid(a.id) >= public.acc_total(a.id) - 0.009);
    select coalesce(sum(amount),0) into paid from public.doctor_payouts where doctor_id = d.id and deleted_at is null;
    select coalesce(jsonb_agg(jsonb_build_object('paid_on', paid_on, 'amount', amount, 'method', method,
             'payout_number', payout_number, 'note', note) order by paid_on desc), '[]'::jsonb)
      into pays from public.doctor_payouts where doctor_id = d.id and deleted_at is null;
  end if;

  return jsonb_build_object('lab', public._portal_lab(),
    'doctor', jsonb_build_object('full_name', d.full_name, 'qualification', d.qualification, 'hospital', d.hospital,
                                 'show_commission', d.portal_show_commission),
    'from', p_from, 'to', p_to, 'cases', rows,
    'account', case when d.portal_show_commission then
       jsonb_build_object('earned_all_time', earned, 'paid_all_time', paid, 'balance', earned - paid, 'payouts', pays) end);
end $$;

-- Report authenticity check (QR on the report). Shows no results.
create or replace function public.verify_report(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a record; p record;
begin
  select * into a from public.accessions where verify_code = p_code and deleted_at is null;
  if a.id is null then return jsonb_build_object('valid', false); end if;
  select * into p from public.patients where id = a.patient_id;
  return jsonb_build_object('valid', true,
    'lab_name', (select lab_name from public.lab_settings where id = 1),
    'acc_number', a.acc_number, 'reg_date', a.reg_date,
    'patient', regexp_replace(p.full_name, '(\S)\S*', '\1***', 'g'),
    'mr_number', p.mr_number,
    'tests', coalesce((select jsonb_agg(jsonb_build_object('name', t.test_name, 'verified_at', t.verified_at,
                         'amended', t.amend_count > 0) order by t.sort_order)
                       from public.accession_tests t where t.accession_id = a.id and t.status = 'verified'), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- 14. One-time copy of data from the older "Clinic & Lab" version
-- ---------------------------------------------------------------------
do $$
declare has_old boolean;
begin
  select exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'lab_orders')
    into has_old;
  if not has_old or exists (select 1 from public.accessions) then return; end if;

  -- settings
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='clinic_settings') then
    execute $q$
      update public.lab_settings s set
        lab_name = coalesce(s.lab_name, c.lab_name, c.clinic_name), logo = coalesce(s.logo, c.logo),
        address = coalesce(s.address, c.address), phone = coalesce(s.phone, c.phone),
        whatsapp = coalesce(s.whatsapp, c.whatsapp), email = coalesce(s.email, c.email),
        working_hours = coalesce(s.working_hours, c.working_hours), currency = c.currency,
        phone_country_code = c.phone_country_code, report_footer = coalesce(s.report_footer, c.report_footer_note)
      from public.clinic_settings c where c.id = 1 and s.id = 1 $q$;
  end if;

  execute $q$
    insert into public.accessions (id, acc_number, patient_id, reg_date, registered_at, doctor_text, discount,
                                   verify_code, deleted_at, delete_reason, created_at)
    select o.id, o.order_number, o.patient_id, o.ordered_at::date, o.ordered_at,
           coalesce(o.referred_by, case when o.source = 'clinic' then 'Clinic' end),
           coalesce((select i.discount from public.invoices i where i.lab_order_id = o.id and i.status <> 'void' limit 1), 0),
           encode(gen_random_bytes(6), 'hex'),
           case when exists (select 1 from public.invoices i where i.lab_order_id = o.id)
                 and not exists (select 1 from public.invoices i where i.lab_order_id = o.id and i.status <> 'void')
                then now() end,
           case when exists (select 1 from public.invoices i where i.lab_order_id = o.id)
                 and not exists (select 1 from public.invoices i where i.lab_order_id = o.id and i.status <> 'void')
                then 'Bill was deleted in the old version' end,
           o.created_at
    from public.lab_orders o where o.deleted_at is null $q$;

  execute $q$
    insert into public.specimens (id, specimen_number, accession_id, sample_type, status, collected_at, reject_reason)
    select s.id, s.sample_number, s.order_id, s.sample_type,
           case when s.status = 'rejected' then 'rejected' else 'collected' end, coalesce(s.received_at, s.collected_at), s.reject_reason
    from public.lab_samples s where exists (select 1 from public.accessions a where a.id = s.order_id) $q$;

  execute $q$
    insert into public.accession_tests (id, accession_id, test_id, test_code, test_name, department, sample_type,
       list_price, price, status, specimen_id, results, remarks, entered_at, entered_by, verified_at, verified_by,
       amend_count, cancelled_at)
    select it.id, it.order_id, it.test_id, t.code, it.test_name, t.category, t.sample_type,
           coalesce(it.price,0), coalesce(it.price,0),
           case it.status when 'ordered' then 'pending' when 'sample_collected' then 'collected'
                when 'received' then 'collected' when 'processing' then 'collected'
                when 'completed' then 'entered' else it.status end,
           it.sample_id, it.results, it.remarks, it.result_entered_at, it.result_entered_by,
           it.verified_at, it.verified_by, case when it.amended then 1 else 0 end,
           case when it.status = 'cancelled' then it.updated_at end
    from public.lab_order_items it join public.lab_tests t on t.id = it.test_id
    where exists (select 1 from public.accessions a where a.id = it.order_id) $q$;

  execute $q$
    insert into public.bill_payments (id, payment_number, accession_id, kind, amount, method, reference,
       business_date, received_at, note)
    select p.id, p.payment_number, i.lab_order_id,
           case when p.kind = 'reversal' then 'refund' else 'payment' end, p.amount, p.method, p.reference,
           p.received_at::date, p.received_at, p.reason
    from public.payments p join public.invoices i on i.id = p.invoice_id
    where i.category = 'lab' and exists (select 1 from public.accessions a where a.id = i.lab_order_id) $q$;

  -- patient master records stay as they are (same table)
  raise notice 'Old lab data copied into the new tables.';
exception when others then
  raise notice 'Old data copy skipped: %', sqlerrm;
end $$;

-- every accession needs a verification code for its QR
update public.accessions set verify_code = encode(gen_random_bytes(6), 'hex') where verify_code is null;

-- ---------------------------------------------------------------------
-- 15. Privileges + Row Level Security
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant usage on schema public to anon, authenticated;
grant select, insert, update on all tables in schema public to authenticated;
revoke insert, update on public.audit_log, public.devices from authenticated;
revoke execute on all functions in schema public from anon, public;
grant execute on function public.app_role(), public.is_admin(), public.is_staff(), public.can_manage(),
  public.register_device(uuid, text), public.device_max_numbers(int),
  public.acc_total(uuid), public.acc_paid(uuid) to authenticated;
grant execute on function public.portal_patient(text, text), public.portal_doctor(text, text, date, date),
  public.verify_report(text) to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['profiles','devices','lab_settings','pathologists','ref_doctors','commission_rules',
    'doctor_payouts','panels','panel_rates','panel_payments','memberships','patients','lab_tests',
    'lab_parameters','lab_reference_ranges','antibiotics','report_templates','outsource_labs',
    'outsource_rates','outsource_payments','accessions','specimens','accession_tests','result_amendments',
    'critical_calls','bill_payments','print_log','expenses','day_closings','inv_items','inv_lots','inv_moves',
    'test_consumption','qc_materials','qc_runs','equipment','equipment_logs','audit_log','sync_conflicts']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

create or replace function public._pol(p_table text, p_name text, p_cmd text, p_using text, p_check text)
returns void language plpgsql as $$
begin
  execute format('drop policy if exists %I on public.%I', p_name, p_table);
  execute format('create policy %I on public.%I for %s to authenticated %s %s',
    p_name, p_table, p_cmd,
    case when p_using is null then '' else 'using (' || p_using || ')' end,
    case when p_check is null then '' else 'with check (' || p_check || ')' end);
end $$;

-- Daily work: every active staff member reads and writes
do $$
declare t text;
begin
  foreach t in array array['patients','accessions','specimens','accession_tests','result_amendments',
    'critical_calls','bill_payments','print_log','inv_moves','qc_runs','equipment_logs','day_closings',
    'expenses','inv_lots']
  loop
    perform public._pol(t, 'staff_s', 'select', 'public.is_staff()', null);
    perform public._pol(t, 'staff_i', 'insert', null, 'public.is_staff()');
    perform public._pol(t, 'staff_u', 'update', 'public.is_staff()', 'public.is_staff()');
  end loop;
  -- Set-up data: everyone reads, Admin/Accountant change
  foreach t in array array['lab_settings','pathologists','ref_doctors','commission_rules','doctor_payouts',
    'panels','panel_rates','panel_payments','memberships','lab_tests','lab_parameters','lab_reference_ranges',
    'antibiotics','report_templates','outsource_labs','outsource_rates','outsource_payments','inv_items',
    'test_consumption','qc_materials','equipment']
  loop
    perform public._pol(t, 'staff_s', 'select', 'public.is_staff()', null);
    perform public._pol(t, 'manage_i', 'insert', null, 'public.can_manage()');
    perform public._pol(t, 'manage_u', 'update', 'public.can_manage()', 'public.can_manage()');
  end loop;
end $$;
-- technicians and pathologists may keep reference ranges, parameters and QC materials up to date
select public._pol('lab_parameters','tech_i','insert',null,'public.app_role() in (''technician'',''pathologist'')');
select public._pol('lab_parameters','tech_u','update','public.app_role() in (''technician'',''pathologist'')','public.app_role() in (''technician'',''pathologist'')');
select public._pol('lab_reference_ranges','tech_i','insert',null,'public.app_role() in (''technician'',''pathologist'')');
select public._pol('lab_reference_ranges','tech_u','update','public.app_role() in (''technician'',''pathologist'')','public.app_role() in (''technician'',''pathologist'')');
select public._pol('qc_materials','tech_i','insert',null,'public.is_staff()');
select public._pol('qc_materials','tech_u','update','public.is_staff()','public.is_staff()');
select public._pol('equipment','tech_i','insert',null,'public.is_staff()');
select public._pol('equipment','tech_u','update','public.is_staff()','public.is_staff()');
select public._pol('inv_items','tech_i','insert',null,'public.is_staff()');
select public._pol('inv_items','tech_u','update','public.is_staff()','public.is_staff()');

select public._pol('profiles','read','select','id = auth.uid() or public.is_admin()',null);
select public._pol('profiles','admin_update','update','public.is_admin()','public.is_admin()');
select public._pol('devices','read','select','public.is_staff()',null);
select public._pol('audit_log','admin_read','select','public.is_admin()',null);
select public._pol('sync_conflicts','s','select','public.is_admin() or user_id = auth.uid()',null);
select public._pol('sync_conflicts','i','insert',null,'public.is_staff() and user_id = auth.uid()');
select public._pol('sync_conflicts','u','update','public.is_admin()','public.is_admin()');

-- ---------------------------------------------------------------------
-- 16. Reference data (tests, ranges, antibiotics, templates). No prices.
-- ---------------------------------------------------------------------
create or replace function public._seed_test(p jsonb) returns void
language plpgsql as $$
declare tid uuid; pid uuid; prm jsonb; rg jsonb; i int := 0;
begin
  insert into public.lab_tests (code, name, category, sample_type, container, tat_hours, instructions,
                                result_kind, method, report_note, price, is_starter, sort_order, kind, auto_verify)
  values (p->>'code', p->>'name', p->>'dept', coalesce(p->>'sample','Serum'), p->>'container',
          (p->>'tat')::int, p->>'prep', coalesce(p->>'kind','parameters'), p->>'method', p->>'note',
          null, true, coalesce((p->>'order')::int, 0), 'test', coalesce((p->>'auto')::boolean, true))
  on conflict do nothing
  returning id into tid;
  if tid is null then
    -- already there (older version / earlier run): only complete a starter test
    -- the lab has not reviewed yet; never touch the lab's own edits.
    select id into tid from public.lab_tests where code = p->>'code' and is_starter and not ranges_reviewed;
    if tid is null then return; end if;
    update public.lab_tests set
      container = coalesce(container, p->>'container'), tat_hours = coalesce(tat_hours, (p->>'tat')::int),
      instructions = coalesce(instructions, p->>'prep'), method = coalesce(method, p->>'method'),
      report_note = coalesce(report_note, p->>'note')
    where id = tid;
  end if;
  for prm in select * from jsonb_array_elements(coalesce(p->'params','[]'::jsonb)) loop
    i := i + 1;
    pid := null;
    insert into public.lab_parameters (test_id, name, code, unit, result_type, options, decimals, sort_order,
                                       formula, critical_low, critical_high, delta_pct, reflex, section, default_value)
    values (tid, prm->>'n', prm->>'c', prm->>'u', coalesce(prm->>'t','numeric'), prm->>'o',
            coalesce((prm->>'d')::int, 1), i, prm->>'f', (prm->>'cl')::numeric, (prm->>'ch')::numeric,
            (prm->>'dp')::numeric, prm->'rx', prm->>'s', prm->>'dv')
    on conflict do nothing
    returning id into pid;
    if pid is null then
      update public.lab_parameters set
        code = coalesce(code, prm->>'c'), critical_low = coalesce(critical_low, (prm->>'cl')::numeric),
        critical_high = coalesce(critical_high, (prm->>'ch')::numeric), delta_pct = coalesce(delta_pct, (prm->>'dp')::numeric),
        reflex = coalesce(reflex, prm->'rx'), section = coalesce(section, prm->>'s'), sort_order = i
      where test_id = tid and lower(name) = lower(prm->>'n');
      continue;
    end if;
    for rg in select * from jsonb_array_elements(coalesce(prm->'r','[]'::jsonb)) loop
      insert into public.lab_reference_ranges (parameter_id, gender, age_min_days, age_max_days, low, high, display_text, note)
      values (pid, coalesce(rg->>'g','any'), coalesce((rg->>'a0')::int, 0), (rg->>'a1')::int,
              (rg->>'lo')::numeric, (rg->>'hi')::numeric, rg->>'x', 'Starter value — confirm for your method');
    end loop;
  end loop;
end $$;

create or replace function public._seed_package(p_code text, p_name text, p_order int, p_codes text[])
returns void language plpgsql as $$
begin
  insert into public.lab_tests (code, name, category, sample_type, price, is_starter, sort_order, kind, components)
  values (p_code, p_name, 'Packages', 'Multiple', null, true, p_order, 'package',
          coalesce((select jsonb_agg(t.id order by array_position(p_codes, t.code))
                    from public.lab_tests t where t.code = any(p_codes)), '[]'::jsonb))
  on conflict do nothing;
end $$;

-- 153 tests, 10 packages, 41 antibiotics (generated from sql/catalogue.mjs)
select public._seed_test($j${"code":"CBC","name":"Complete Blood Count (CBC)","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":4,"order":10,"params":[{"n":"Haemoglobin","u":"g/dL","d":1,"r":[{"a0":6570,"g":"male","lo":13,"hi":17},{"a0":6570,"g":"female","lo":12,"hi":15}],"c":"HB","cl":7,"ch":20,"dp":20},{"n":"RBC count","u":"x10^6/µL","d":2,"r":[{"a0":6570,"g":"male","lo":4.5,"hi":5.5},{"a0":6570,"g":"female","lo":3.8,"hi":4.8}],"c":"RBC"},{"n":"Haematocrit (HCT)","u":"%","d":1,"r":[{"a0":6570,"g":"male","lo":40,"hi":50},{"a0":6570,"g":"female","lo":36,"hi":46}],"c":"HCT"},{"n":"MCV","u":"fL","d":1,"r":[{"a0":6570,"lo":80,"hi":100}],"c":"MCV"},{"n":"MCH","u":"pg","d":1,"r":[{"a0":6570,"lo":27,"hi":32}],"c":"MCH"},{"n":"MCHC","u":"g/dL","d":1,"r":[{"a0":6570,"lo":31.5,"hi":34.5}],"c":"MCHC"},{"n":"RDW-CV","u":"%","d":1,"r":[{"a0":6570,"lo":11.6,"hi":14}],"c":"RDW"},{"n":"Total WBC count","u":"x10^3/µL","d":1,"r":[{"a0":6570,"lo":4,"hi":11}],"c":"WBC","cl":2,"ch":30,"dp":50},{"n":"Neutrophils","u":"%","d":0,"r":[{"a0":6570,"lo":40,"hi":75}],"c":"NEU","s":"Differential count"},{"n":"Lymphocytes","u":"%","d":0,"r":[{"a0":6570,"lo":20,"hi":45}],"c":"LYM","s":"Differential count"},{"n":"Monocytes","u":"%","d":0,"r":[{"a0":6570,"lo":2,"hi":10}],"c":"MONO","s":"Differential count"},{"n":"Eosinophils","u":"%","d":0,"r":[{"a0":6570,"lo":1,"hi":6}],"c":"EOS","s":"Differential count"},{"n":"Basophils","u":"%","d":0,"r":[{"a0":6570,"lo":0,"hi":2}],"c":"BASO","s":"Differential count"},{"n":"Platelet count","u":"x10^3/µL","d":0,"r":[{"a0":6570,"lo":150,"hi":400}],"c":"PLT","cl":30,"ch":1000,"dp":40}]}$j$::jsonb);
select public._seed_test($j${"code":"HB","name":"Haemoglobin (Hb)","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":2,"order":20,"params":[{"n":"Haemoglobin","u":"g/dL","d":1,"r":[{"a0":6570,"g":"male","lo":13,"hi":17},{"a0":6570,"g":"female","lo":12,"hi":15}],"c":"HB","cl":7,"ch":20,"dp":20}]}$j$::jsonb);
select public._seed_test($j${"code":"TLCDLC","name":"TLC & DLC","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":3,"order":30,"params":[{"n":"Total WBC count","u":"x10^3/µL","d":1,"r":[{"a0":6570,"lo":4,"hi":11}],"c":"WBC","cl":2,"ch":30},{"n":"Neutrophils","u":"%","d":0,"r":[{"a0":6570,"lo":40,"hi":75}]},{"n":"Lymphocytes","u":"%","d":0,"r":[{"a0":6570,"lo":20,"hi":45}]},{"n":"Monocytes","u":"%","d":0,"r":[{"a0":6570,"lo":2,"hi":10}]},{"n":"Eosinophils","u":"%","d":0,"r":[{"a0":6570,"lo":1,"hi":6}]},{"n":"Basophils","u":"%","d":0,"r":[{"a0":6570,"lo":0,"hi":2}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PLT","name":"Platelet Count","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":2,"order":40,"params":[{"n":"Platelet count","u":"x10^3/µL","d":0,"r":[{"a0":6570,"lo":150,"hi":400}],"c":"PLT","cl":30,"ch":1000}]}$j$::jsonb);
select public._seed_test($j${"code":"ESR","name":"ESR (Westergren)","dept":"Haematology","sample":"Whole blood","container":"EDTA / Citrate","tat":2,"order":50,"params":[{"n":"ESR (1st hour)","u":"mm/hr","d":0,"r":[{"a0":6570,"g":"male","lo":0,"hi":15},{"a0":6570,"g":"female","lo":0,"hi":20}]}]}$j$::jsonb);
select public._seed_test($j${"code":"RETIC","name":"Reticulocyte Count","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":6,"order":60,"params":[{"n":"Reticulocytes","u":"%","d":1,"r":[{"a0":6570,"lo":0.5,"hi":2.5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AEC","name":"Absolute Eosinophil Count","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":4,"order":70,"params":[{"n":"Absolute eosinophil count","u":"/µL","d":0,"r":[{"a0":6570,"lo":40,"hi":440}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PS","name":"Peripheral Blood Smear","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":24,"order":80,"auto":false,"params":[{"n":"RBC morphology","t":"text","r":[{"x":"Normocytic normochromic"}]},{"n":"WBC morphology","t":"text","r":[{"x":"Normal"}]},{"n":"Platelets","t":"text","r":[{"x":"Adequate"}]},{"n":"Haemoparasites","t":"text","r":[{"x":"Not seen"}]},{"n":"Impression","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"MP","name":"Malaria Parasite (Smear)","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":2,"order":90,"params":[{"n":"Malaria parasite","t":"option","o":"Not seen,P. vivax seen,P. falciparum seen,Mixed infection","r":[{"x":"Not seen"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"MPICT","name":"Malaria Antigen (ICT)","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":1,"order":100,"params":[{"n":"P. falciparum antigen","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]},{"n":"P. vivax antigen","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BG","name":"Blood Group & Rh","dept":"Blood Bank","sample":"Whole blood","container":"EDTA (purple)","tat":1,"order":110,"params":[{"n":"ABO group","t":"option","o":"A,B,AB,O","r":[]},{"n":"Rh (D) factor","t":"option","o":"Positive,Negative","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"G6PD","name":"G6PD Screening","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":24,"order":120,"params":[{"n":"G6PD","t":"option","o":"Normal,Deficient","r":[{"x":"Normal"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"SICK","name":"Sickling Test","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":24,"order":130,"params":[{"n":"Sickling","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBEP","name":"Hb Electrophoresis","dept":"Haematology","sample":"Whole blood","container":"EDTA (purple)","tat":72,"order":140,"auto":false,"params":[{"n":"HbA","u":"%","d":1,"r":[{"a0":6570,"lo":95,"hi":98}]},{"n":"HbA2","u":"%","d":1,"r":[{"a0":6570,"lo":1.5,"hi":3.5}]},{"n":"HbF","u":"%","d":1,"r":[{"a0":6570,"lo":0,"hi":2}]},{"n":"Abnormal bands","t":"text","r":[{"x":"None"}]},{"n":"Interpretation","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"PT","name":"Prothrombin Time (PT / INR)","dept":"Coagulation","sample":"Plasma","container":"Citrate (blue)","tat":3,"order":150,"params":[{"n":"PT (patient)","u":"sec","d":1,"r":[{"a0":6570,"lo":11,"hi":13.5}],"c":"PTP"},{"n":"PT (control)","u":"sec","d":1,"r":[],"c":"PTC"},{"n":"INR","u":"","d":2,"r":[{"a0":6570,"lo":0.8,"hi":1.2}],"c":"INR","ch":5}]}$j$::jsonb);
select public._seed_test($j${"code":"APTT","name":"APTT","dept":"Coagulation","sample":"Plasma","container":"Citrate (blue)","tat":3,"order":160,"params":[{"n":"APTT (patient)","u":"sec","d":1,"r":[{"a0":6570,"lo":25,"hi":35}]},{"n":"APTT (control)","u":"sec","d":1,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"BTCT","name":"Bleeding Time & Clotting Time","dept":"Coagulation","sample":"Capillary blood","container":"—","tat":1,"order":170,"params":[{"n":"Bleeding time","t":"text","r":[{"x":"2 – 7 min"}]},{"n":"Clotting time","t":"text","r":[{"x":"5 – 10 min"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FIB","name":"Fibrinogen","dept":"Coagulation","sample":"Plasma","container":"Citrate (blue)","tat":6,"order":180,"params":[{"n":"Fibrinogen","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":200,"hi":400}],"cl":100}]}$j$::jsonb);
select public._seed_test($j${"code":"DDIM","name":"D-Dimer","dept":"Coagulation","sample":"Plasma","container":"Citrate (blue)","tat":4,"order":190,"params":[{"n":"D-Dimer","u":"µg/mL FEU","d":2,"r":[{"a0":6570,"lo":0,"hi":0.5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BSF","name":"Blood Sugar (Fasting)","dept":"Clinical Chemistry","sample":"Plasma","container":"Fluoride (grey)","tat":2,"prep":"Fasting 8–10 hours (water allowed).","order":200,"params":[{"n":"Fasting blood glucose","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":70,"hi":99}],"c":"FBS","cl":50,"ch":400}]}$j$::jsonb);
select public._seed_test($j${"code":"BSR","name":"Blood Sugar (Random)","dept":"Clinical Chemistry","sample":"Plasma","container":"Fluoride (grey)","tat":1,"order":210,"params":[{"n":"Random blood glucose","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":70,"hi":140}],"c":"RBS","cl":50,"ch":400}]}$j$::jsonb);
select public._seed_test($j${"code":"BSPP","name":"Blood Sugar (2 hours after meal)","dept":"Clinical Chemistry","sample":"Plasma","container":"Fluoride (grey)","tat":2,"prep":"Sample exactly 2 hours after starting a normal meal.","order":220,"params":[{"n":"2-hour post-prandial glucose","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":70,"hi":140}],"cl":50,"ch":400}]}$j$::jsonb);
select public._seed_test($j${"code":"OGTT","name":"Glucose Tolerance Test (75 g OGTT)","dept":"Clinical Chemistry","sample":"Plasma","container":"Fluoride (grey)","tat":4,"prep":"Fasting 8–10 hours (water allowed). Stay at the lab for 2 hours after the glucose drink.","order":230,"params":[{"n":"Fasting glucose","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":70,"hi":99}],"cl":50,"ch":400},{"n":"Glucose at 1 hour","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":180}]},{"n":"Glucose at 2 hours","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":140}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBA1C","name":"HbA1c (Glycated Haemoglobin)","dept":"Clinical Chemistry","sample":"Whole blood","container":"EDTA (purple)","tat":4,"note":"HbA1c: below 5.7% normal · 5.7–6.4% prediabetes · 6.5% or more diabetes (ADA).","order":240,"params":[{"n":"HbA1c","u":"%","d":1,"r":[{"a0":6570,"lo":4,"hi":5.6}],"c":"A1C"},{"n":"Estimated average glucose (eAG)","u":"mg/dL","t":"calculated","f":"28.7*{A1C}-46.7","d":0,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"LFT","name":"Liver Function Tests (LFT)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"order":250,"params":[{"n":"Total bilirubin","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":0.3,"hi":1.2}],"c":"TBIL","ch":15},{"n":"Direct bilirubin","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":0,"hi":0.3}],"c":"DBIL"},{"n":"Indirect bilirubin","u":"mg/dL","t":"calculated","f":"{TBIL}-{DBIL}","d":1,"r":[{"a0":6570,"lo":0.2,"hi":0.9}]},{"n":"ALT (SGPT)","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":40}]},{"n":"AST (SGOT)","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":40}]},{"n":"Alkaline phosphatase","u":"U/L","d":0,"r":[{"a0":6570,"lo":40,"hi":130}]},{"n":"Gamma GT","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":55}]},{"n":"Total protein","u":"g/dL","d":1,"r":[{"a0":6570,"lo":6,"hi":8.3}],"c":"TP"},{"n":"Albumin","u":"g/dL","d":1,"r":[{"a0":6570,"lo":3.5,"hi":5}],"c":"ALB"},{"n":"Globulin","u":"g/dL","t":"calculated","f":"{TP}-{ALB}","d":1,"r":[{"a0":6570,"lo":2,"hi":3.5}],"c":"GLOB"},{"n":"A/G ratio","u":"","t":"calculated","f":"{ALB}/({TP}-{ALB})","d":2,"r":[{"a0":6570,"lo":1,"hi":2.2}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BIL","name":"Bilirubin (Total & Direct)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":260,"params":[{"n":"Total bilirubin","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":0.3,"hi":1.2}],"c":"TBIL","ch":15},{"n":"Direct bilirubin","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":0,"hi":0.3}],"c":"DBIL"},{"n":"Indirect bilirubin","u":"mg/dL","t":"calculated","f":"{TBIL}-{DBIL}","d":1,"r":[{"a0":6570,"lo":0.2,"hi":0.9}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ALT","name":"ALT (SGPT)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":270,"params":[{"n":"ALT (SGPT)","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":40}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AST","name":"AST (SGOT)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":280,"params":[{"n":"AST (SGOT)","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":40}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ALP","name":"Alkaline Phosphatase","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":290,"params":[{"n":"Alkaline phosphatase","u":"U/L","d":0,"r":[{"a0":6570,"lo":40,"hi":130}]}]}$j$::jsonb);
select public._seed_test($j${"code":"GGT","name":"Gamma GT","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":300,"params":[{"n":"Gamma GT","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":55}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TPALB","name":"Total Protein & Albumin","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":310,"params":[{"n":"Total protein","u":"g/dL","d":1,"r":[{"a0":6570,"lo":6,"hi":8.3}],"c":"TP"},{"n":"Albumin","u":"g/dL","d":1,"r":[{"a0":6570,"lo":3.5,"hi":5}],"c":"ALB"},{"n":"Globulin","u":"g/dL","t":"calculated","f":"{TP}-{ALB}","d":1,"r":[{"a0":6570,"lo":2,"hi":3.5}]},{"n":"A/G ratio","u":"","t":"calculated","f":"{ALB}/({TP}-{ALB})","d":2,"r":[{"a0":6570,"lo":1,"hi":2.2}]}]}$j$::jsonb);
select public._seed_test($j${"code":"RFT","name":"Renal Function Tests (RFT)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"order":320,"params":[{"n":"Urea","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":15,"hi":45}],"c":"UREA"},{"n":"BUN","u":"mg/dL","t":"calculated","f":"{UREA}*0.467","d":0,"r":[{"a0":6570,"lo":7,"hi":21}]},{"n":"Creatinine","u":"mg/dL","d":2,"r":[{"a0":6570,"g":"male","lo":0.7,"hi":1.3},{"a0":6570,"g":"female","lo":0.6,"hi":1.1}],"c":"CREAT","ch":5,"dp":50},{"n":"eGFR (CKD-EPI 2021)","u":"mL/min/1.73m²","t":"calculated","f":"142*pow(min({CREAT}/(FEMALE?0.7:0.9),1),(FEMALE?-0.241:-0.302))*pow(max({CREAT}/(FEMALE?0.7:0.9),1),-1.2)*pow(0.9938,AGE)*(FEMALE?1.012:1)","d":0,"r":[{"a0":6570,"lo":90}]},{"n":"Uric acid","u":"mg/dL","d":1,"r":[{"a0":6570,"g":"male","lo":3.5,"hi":7.2},{"a0":6570,"g":"female","lo":2.6,"hi":6}]},{"n":"Sodium","u":"mmol/L","d":0,"r":[{"a0":6570,"lo":135,"hi":145}],"cl":125,"ch":155},{"n":"Potassium","u":"mmol/L","d":1,"r":[{"a0":6570,"lo":3.5,"hi":5.1}],"cl":3,"ch":6,"dp":20},{"n":"Chloride","u":"mmol/L","d":0,"r":[{"a0":6570,"lo":98,"hi":107}]}]}$j$::jsonb);
select public._seed_test($j${"code":"UREA","name":"Urea","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":330,"params":[{"n":"Urea","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":15,"hi":45}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CREAT","name":"Creatinine","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":340,"params":[{"n":"Creatinine","u":"mg/dL","d":2,"r":[{"a0":6570,"g":"male","lo":0.7,"hi":1.3},{"a0":6570,"g":"female","lo":0.6,"hi":1.1}],"c":"CREAT","ch":5,"dp":50},{"n":"eGFR (CKD-EPI 2021)","u":"mL/min/1.73m²","t":"calculated","f":"142*pow(min({CREAT}/(FEMALE?0.7:0.9),1),(FEMALE?-0.241:-0.302))*pow(max({CREAT}/(FEMALE?0.7:0.9),1),-1.2)*pow(0.9938,AGE)*(FEMALE?1.012:1)","d":0,"r":[{"a0":6570,"lo":90}]}]}$j$::jsonb);
select public._seed_test($j${"code":"UA","name":"Uric Acid","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":350,"params":[{"n":"Uric acid","u":"mg/dL","d":1,"r":[{"a0":6570,"g":"male","lo":3.5,"hi":7.2},{"a0":6570,"g":"female","lo":2.6,"hi":6}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ELEC","name":"Serum Electrolytes","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":360,"params":[{"n":"Sodium","u":"mmol/L","d":0,"r":[{"a0":6570,"lo":135,"hi":145}],"cl":125,"ch":155},{"n":"Potassium","u":"mmol/L","d":1,"r":[{"a0":6570,"lo":3.5,"hi":5.1}],"cl":3,"ch":6,"dp":20},{"n":"Chloride","u":"mmol/L","d":0,"r":[{"a0":6570,"lo":98,"hi":107}]},{"n":"Bicarbonate","u":"mmol/L","d":0,"r":[{"a0":6570,"lo":22,"hi":29}],"cl":12,"ch":40}]}$j$::jsonb);
select public._seed_test($j${"code":"CA","name":"Serum Calcium","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":370,"params":[{"n":"Calcium","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":8.5,"hi":10.5}],"cl":7,"ch":12}]}$j$::jsonb);
select public._seed_test($j${"code":"ICA","name":"Ionised Calcium","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"order":380,"params":[{"n":"Ionised calcium","u":"mmol/L","d":2,"r":[{"a0":6570,"lo":1.12,"hi":1.32}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PHOS","name":"Serum Phosphorus","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":390,"params":[{"n":"Phosphorus","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":2.5,"hi":4.5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"MG","name":"Serum Magnesium","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":400,"params":[{"n":"Magnesium","u":"mg/dL","d":1,"r":[{"a0":6570,"lo":1.7,"hi":2.4}],"cl":1}]}$j$::jsonb);
select public._seed_test($j${"code":"LIPID","name":"Lipid Profile","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"prep":"Fasting 10–12 hours (water allowed). No fatty meal the night before.","note":"Calculated LDL (Friedewald) is not valid when triglycerides are above 400 mg/dL.","order":410,"params":[{"n":"Total cholesterol","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":200}],"c":"TC"},{"n":"Triglycerides","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":150}],"c":"TG"},{"n":"HDL cholesterol","u":"mg/dL","d":0,"r":[{"a0":6570,"g":"male","lo":40},{"a0":6570,"g":"female","lo":50}],"c":"HDL"},{"n":"LDL cholesterol (calculated)","u":"mg/dL","t":"calculated","f":"{TC}-{HDL}-{TG}/5","d":0,"r":[{"a0":6570,"hi":100}]},{"n":"VLDL cholesterol","u":"mg/dL","t":"calculated","f":"{TG}/5","d":0,"r":[{"a0":6570,"lo":5,"hi":40}]},{"n":"Non-HDL cholesterol","u":"mg/dL","t":"calculated","f":"{TC}-{HDL}","d":0,"r":[{"a0":6570,"hi":130}]},{"n":"Cholesterol / HDL ratio","u":"","t":"calculated","f":"{TC}/{HDL}","d":1,"r":[{"a0":6570,"hi":5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CHOL","name":"Cholesterol (Total)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":420,"params":[{"n":"Total cholesterol","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":200}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TG","name":"Triglycerides","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"prep":"Fasting 10–12 hours (water allowed). No fatty meal the night before.","order":430,"params":[{"n":"Triglycerides","u":"mg/dL","d":0,"r":[{"a0":6570,"hi":150}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AMY","name":"Serum Amylase","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":440,"params":[{"n":"Amylase","u":"U/L","d":0,"r":[{"a0":6570,"lo":28,"hi":100}]}]}$j$::jsonb);
select public._seed_test($j${"code":"LIP","name":"Serum Lipase","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":450,"params":[{"n":"Lipase","u":"U/L","d":0,"r":[{"a0":6570,"lo":13,"hi":60}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CK","name":"CPK (Total CK)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":460,"params":[{"n":"CK (total)","u":"U/L","d":0,"r":[{"a0":6570,"g":"male","lo":39,"hi":308},{"a0":6570,"g":"female","lo":26,"hi":192}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CKMB","name":"CK-MB","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":470,"params":[{"n":"CK-MB","u":"U/L","d":0,"r":[{"a0":6570,"lo":0,"hi":25}]}]}$j$::jsonb);
select public._seed_test($j${"code":"LDH","name":"LDH","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":480,"params":[{"n":"LDH","u":"U/L","d":0,"r":[{"a0":6570,"lo":140,"hi":280}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TROPI","name":"Troponin I (Quantitative)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":1,"order":490,"auto":false,"params":[{"n":"Troponin I","u":"ng/mL","d":3,"r":[{"a0":6570,"lo":0,"hi":0.04}],"ch":0.04}]}$j$::jsonb);
select public._seed_test($j${"code":"TROPT","name":"Troponin T (Rapid)","dept":"Clinical Chemistry","sample":"Whole blood","container":"Heparin / EDTA","tat":1,"order":500,"auto":false,"params":[{"n":"Troponin T","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CRP","name":"C-Reactive Protein (CRP)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":3,"order":510,"params":[{"n":"CRP","u":"mg/L","d":1,"r":[{"a0":6570,"lo":0,"hi":5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HSCRP","name":"hs-CRP","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":6,"note":"Cardiac risk: below 1 mg/L low · 1–3 average · above 3 high.","order":520,"params":[{"n":"hs-CRP","u":"mg/L","d":2,"r":[{"a0":6570,"lo":0,"hi":1}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PCT","name":"Procalcitonin","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"order":530,"params":[{"n":"Procalcitonin","u":"ng/mL","d":2,"r":[{"a0":6570,"lo":0,"hi":0.5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BNP","name":"NT-proBNP","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":6,"order":540,"params":[{"n":"NT-proBNP","u":"pg/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":125}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HCY","name":"Homocysteine","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":24,"order":550,"params":[{"n":"Homocysteine","u":"µmol/L","d":1,"r":[{"a0":6570,"lo":5,"hi":15}]}]}$j$::jsonb);
select public._seed_test($j${"code":"IRON","name":"Iron Studies (Fe, TIBC, Ferritin)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":6,"order":560,"params":[{"n":"Serum iron","u":"µg/dL","d":0,"r":[{"a0":6570,"g":"male","lo":65,"hi":175},{"a0":6570,"g":"female","lo":50,"hi":170}],"c":"FE"},{"n":"TIBC","u":"µg/dL","d":0,"r":[{"a0":6570,"lo":250,"hi":450}],"c":"TIBC"},{"n":"Transferrin saturation","u":"%","t":"calculated","f":"{FE}/{TIBC}*100","d":0,"r":[{"a0":6570,"lo":20,"hi":50}]},{"n":"Ferritin","u":"ng/mL","d":0,"r":[{"a0":6570,"g":"male","lo":30,"hi":400},{"a0":6570,"g":"female","lo":15,"hi":150}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FE","name":"Serum Iron","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":4,"order":570,"params":[{"n":"Serum iron","u":"µg/dL","d":0,"r":[{"a0":6570,"g":"male","lo":65,"hi":175},{"a0":6570,"g":"female","lo":50,"hi":170}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FERR","name":"Serum Ferritin","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":6,"order":580,"params":[{"n":"Ferritin","u":"ng/mL","d":0,"r":[{"a0":6570,"g":"male","lo":30,"hi":400},{"a0":6570,"g":"female","lo":15,"hi":150}]}]}$j$::jsonb);
select public._seed_test($j${"code":"B12","name":"Vitamin B12","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":24,"order":590,"params":[{"n":"Vitamin B12","u":"pg/mL","d":0,"r":[{"a0":6570,"lo":200,"hi":900}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FOL","name":"Folate (Serum)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":24,"order":600,"params":[{"n":"Folate","u":"ng/mL","d":1,"r":[{"a0":6570,"lo":3,"hi":17}]}]}$j$::jsonb);
select public._seed_test($j${"code":"VITD","name":"Vitamin D (25-OH)","dept":"Clinical Chemistry","sample":"Serum","container":"Gel / Red","tat":24,"note":"Below 20 ng/mL deficient · 20–29 insufficient · 30–100 sufficient.","order":610,"params":[{"n":"25-OH Vitamin D","u":"ng/mL","d":1,"r":[{"a0":6570,"lo":30,"hi":100}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ZN","name":"Serum Zinc","dept":"Clinical Chemistry","sample":"Serum","container":"Trace-element tube","tat":48,"order":620,"params":[{"n":"Zinc","u":"µg/dL","d":0,"r":[{"a0":6570,"lo":70,"hi":120}]}]}$j$::jsonb);
select public._seed_test($j${"code":"NH3","name":"Ammonia","dept":"Clinical Chemistry","sample":"Plasma","container":"EDTA on ice","tat":2,"prep":"Sample must reach the lab on ice within 30 minutes.","order":630,"params":[{"n":"Ammonia","u":"µmol/L","d":0,"r":[{"a0":6570,"lo":11,"hi":32}]}]}$j$::jsonb);
select public._seed_test($j${"code":"LACT","name":"Lactate","dept":"Clinical Chemistry","sample":"Plasma","container":"Fluoride (grey)","tat":2,"order":640,"params":[{"n":"Lactate","u":"mmol/L","d":1,"r":[{"a0":6570,"lo":0.5,"hi":2.2}],"ch":4}]}$j$::jsonb);
select public._seed_test($j${"code":"MALB","name":"Urine Microalbumin (ACR)","dept":"Clinical Chemistry","sample":"Urine","container":"Sterile container","tat":6,"prep":"Early-morning urine sample.","note":"ACR: below 30 normal · 30–300 moderately increased · above 300 severely increased.","order":650,"params":[{"n":"Urine albumin","u":"mg/L","d":1,"r":[],"c":"UALB"},{"n":"Urine creatinine","u":"mg/dL","d":1,"r":[],"c":"UCR"},{"n":"Albumin / creatinine ratio","u":"mg/g","t":"calculated","f":"{UALB}/{UCR}*100","d":0,"r":[{"a0":6570,"hi":30}]}]}$j$::jsonb);
select public._seed_test($j${"code":"UPROT24","name":"24-hour Urine Protein","dept":"Clinical Chemistry","sample":"Urine (24 h)","container":"24-hour container","tat":24,"prep":"Collect all urine for 24 hours in the container given by the lab. Discard the first morning sample, then collect every sample until the same time next morning.","order":660,"params":[{"n":"Urine volume","u":"mL","d":0,"r":[],"c":"VOL"},{"n":"Protein concentration","u":"mg/dL","d":1,"r":[],"c":"UP"},{"n":"Protein (24 hours)","u":"mg/24 h","t":"calculated","f":"{UP}*{VOL}/100","d":0,"r":[{"a0":6570,"hi":150}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TSH","name":"TSH","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":670,"params":[{"n":"TSH","u":"µIU/mL","d":2,"r":[{"a0":6570,"lo":0.4,"hi":4}],"c":"TSH","rx":{"when":"abnormal","test":"FT4"}}]}$j$::jsonb);
select public._seed_test($j${"code":"FT4","name":"Free T4","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":680,"params":[{"n":"Free T4","u":"ng/dL","d":2,"r":[{"a0":6570,"lo":0.8,"hi":1.8}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FT3","name":"Free T3","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":690,"params":[{"n":"Free T3","u":"pg/mL","d":2,"r":[{"a0":6570,"lo":2.3,"hi":4.2}]}]}$j$::jsonb);
select public._seed_test($j${"code":"T3","name":"T3 (Total)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":700,"params":[{"n":"T3 (total)","u":"ng/dL","d":0,"r":[{"a0":6570,"lo":80,"hi":200}]}]}$j$::jsonb);
select public._seed_test($j${"code":"T4","name":"T4 (Total)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":710,"params":[{"n":"T4 (total)","u":"µg/dL","d":1,"r":[{"a0":6570,"lo":5,"hi":12}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TFT","name":"Thyroid Profile (TSH, FT4)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":720,"params":[{"n":"TSH","u":"µIU/mL","d":2,"r":[{"a0":6570,"lo":0.4,"hi":4}]},{"n":"Free T4","u":"ng/dL","d":2,"r":[{"a0":6570,"lo":0.8,"hi":1.8}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TFTF","name":"Thyroid Profile (FT3, FT4, TSH)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":730,"params":[{"n":"Free T3","u":"pg/mL","d":2,"r":[{"a0":6570,"lo":2.3,"hi":4.2}]},{"n":"Free T4","u":"ng/dL","d":2,"r":[{"a0":6570,"lo":0.8,"hi":1.8}]},{"n":"TSH","u":"µIU/mL","d":2,"r":[{"a0":6570,"lo":0.4,"hi":4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TFTT","name":"Thyroid Profile (T3, T4, TSH)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"order":740,"params":[{"n":"T3 (total)","u":"ng/dL","d":0,"r":[{"a0":6570,"lo":80,"hi":200}]},{"n":"T4 (total)","u":"µg/dL","d":1,"r":[{"a0":6570,"lo":5,"hi":12}]},{"n":"TSH","u":"µIU/mL","d":2,"r":[{"a0":6570,"lo":0.4,"hi":4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ATPO","name":"Anti-TPO Antibodies","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":24,"order":750,"params":[{"n":"Anti-TPO","u":"IU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":34}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PRL","name":"Prolactin","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"prep":"Sample preferably between 8 and 10 AM. Rest for 30 minutes before the sample.","order":760,"params":[{"n":"Prolactin","u":"ng/mL","d":1,"r":[{"a0":6570,"g":"male","lo":4,"hi":15.2},{"a0":6570,"g":"female","lo":4.8,"hi":23.3}]}]}$j$::jsonb);
select public._seed_test($j${"code":"LH","name":"LH","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"note":"Female LH varies with cycle phase: follicular 2.4–12.6 · mid-cycle 14–96 · luteal 1.0–11.4 · post-menopause 7.7–59 mIU/mL.","order":770,"params":[{"n":"LH","u":"mIU/mL","d":1,"r":[{"a0":6570,"g":"male","lo":1.7,"hi":8.6}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FSH","name":"FSH","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"note":"Female FSH varies with cycle phase: follicular 3.5–12.5 · mid-cycle 4.7–21.5 · luteal 1.7–7.7 · post-menopause 25.8–134.8 mIU/mL.","order":780,"params":[{"n":"FSH","u":"mIU/mL","d":1,"r":[{"a0":6570,"g":"male","lo":1.5,"hi":12.4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"E2","name":"Estradiol (E2)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"note":"Female estradiol varies with cycle phase: follicular 12.5–166 · mid-cycle 85.8–498 · luteal 43.8–211 · post-menopause below 54.7 pg/mL. Male 7.6–42.6 pg/mL.","order":790,"params":[{"n":"Estradiol","u":"pg/mL","d":0,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"PROG","name":"Progesterone","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"note":"Female: follicular 0.06–0.89 · luteal 1.8–23.9 ng/mL (peak on day 21). Male 0.2–1.4 ng/mL.","order":800,"params":[{"n":"Progesterone","u":"ng/mL","d":2,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"TESTO","name":"Testosterone (Total)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"prep":"Sample preferably between 8 and 10 AM.","order":810,"params":[{"n":"Testosterone","u":"ng/dL","d":0,"r":[{"a0":6570,"g":"male","lo":264,"hi":916},{"a0":6570,"g":"female","lo":15,"hi":70}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BHCG","name":"Beta hCG (Quantitative)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":3,"note":"Above 25 mIU/mL is generally consistent with pregnancy; correlate with dates.","order":820,"params":[{"n":"β-hCG","u":"mIU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CORT","name":"Cortisol (Morning)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":6,"prep":"Sample between 8 and 10 AM.","order":830,"params":[{"n":"Cortisol (8–10 AM)","u":"µg/dL","d":1,"r":[{"a0":6570,"lo":6.2,"hi":19.4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"INS","name":"Insulin (Fasting)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":24,"prep":"Fasting 8–10 hours (water allowed).","order":840,"params":[{"n":"Fasting insulin","u":"µIU/mL","d":1,"r":[{"a0":6570,"lo":2.6,"hi":24.9}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CPEP","name":"C-Peptide","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":24,"prep":"Fasting 8–10 hours (water allowed).","order":850,"params":[{"n":"C-peptide","u":"ng/mL","d":1,"r":[{"a0":6570,"lo":1.1,"hi":4.4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PTH","name":"Parathyroid Hormone (PTH)","dept":"Hormones","sample":"Serum","container":"EDTA (purple)","tat":24,"order":860,"params":[{"n":"PTH (intact)","u":"pg/mL","d":0,"r":[{"a0":6570,"lo":15,"hi":65}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AMH","name":"Anti-Müllerian Hormone (AMH)","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":48,"note":"AMH falls with age; interpret against age-specific values for ovarian reserve.","order":870,"params":[{"n":"AMH","u":"ng/mL","d":2,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"DHEAS","name":"DHEA-S","dept":"Hormones","sample":"Serum","container":"Gel / Red","tat":48,"order":880,"params":[{"n":"DHEA-S","u":"µg/dL","d":0,"r":[{"a0":6570,"g":"male","lo":80,"hi":560},{"a0":6570,"g":"female","lo":35,"hi":430}]}]}$j$::jsonb);
select public._seed_test($j${"code":"PSA","name":"PSA (Total)","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"prep":"Avoid ejaculation and cycling for 48 hours before the test.","order":890,"params":[{"n":"PSA (total)","u":"ng/mL","d":2,"r":[{"a0":6570,"lo":0,"hi":4}]}]}$j$::jsonb);
select public._seed_test($j${"code":"FPSA","name":"PSA (Free & Total)","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"order":900,"params":[{"n":"PSA (total)","u":"ng/mL","d":2,"r":[{"a0":6570,"lo":0,"hi":4}],"c":"TPSA"},{"n":"PSA (free)","u":"ng/mL","d":2,"r":[],"c":"FPSA"},{"n":"Free / total PSA","u":"%","t":"calculated","f":"{FPSA}/{TPSA}*100","d":0,"r":[{"a0":6570,"lo":25}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CEA","name":"CEA","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"note":"Smokers may have values up to 10 ng/mL.","order":910,"params":[{"n":"CEA","u":"ng/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":5}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CA125","name":"CA-125","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"order":920,"params":[{"n":"CA-125","u":"U/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":35}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CA199","name":"CA 19-9","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"order":930,"params":[{"n":"CA 19-9","u":"U/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":37}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CA153","name":"CA 15-3","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"order":940,"params":[{"n":"CA 15-3","u":"U/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":30}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AFP","name":"Alpha-Fetoprotein (AFP)","dept":"Tumour Markers","sample":"Serum","container":"Gel / Red","tat":24,"order":950,"params":[{"n":"AFP","u":"ng/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":10}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBSAG","name":"HBsAg (Hepatitis B)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"method":"Immunochromatography (ICT)","order":960,"params":[{"n":"HBsAg","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}],"rx":{"when":"abnormal","test":"HBVPCR"}}]}$j$::jsonb);
select public._seed_test($j${"code":"HCV","name":"Anti-HCV (Hepatitis C)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"method":"Immunochromatography (ICT)","order":970,"params":[{"n":"Anti-HCV","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}],"rx":{"when":"abnormal","test":"HCVPCR"}}]}$j$::jsonb);
select public._seed_test($j${"code":"HIV","name":"HIV 1 & 2 Antibodies","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":980,"auto":false,"params":[{"n":"HIV 1 & 2 antibodies","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBSAGE","name":"HBsAg (ELISA / CLIA)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":990,"params":[{"n":"HBsAg index (S/CO)","u":"","d":2,"r":[{"a0":6570,"hi":1}]},{"n":"Result","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HCVE","name":"Anti-HCV (ELISA / CLIA)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1000,"params":[{"n":"Anti-HCV index (S/CO)","u":"","d":2,"r":[{"a0":6570,"hi":1}]},{"n":"Result","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBEAG","name":"HBeAg","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1010,"params":[{"n":"HBeAg","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AHBS","name":"Anti-HBs (Titre)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"note":"10 mIU/mL or more indicates protective immunity.","order":1020,"params":[{"n":"Anti-HBs","u":"mIU/mL","d":0,"r":[{"a0":6570,"lo":10}]}]}$j$::jsonb);
select public._seed_test($j${"code":"AHBC","name":"Anti-HBc (Total)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1030,"params":[{"n":"Anti-HBc","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HAV","name":"Hepatitis A IgM","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1040,"params":[{"n":"Anti-HAV IgM","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HEV","name":"Hepatitis E IgM","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1050,"params":[{"n":"Anti-HEV IgM","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"VDRL","name":"VDRL / RPR","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":4,"order":1060,"params":[{"n":"VDRL","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TYPHI","name":"Typhidot (IgM / IgG)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":1070,"params":[{"n":"Typhidot IgM","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]},{"n":"Typhidot IgG","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"WIDAL","name":"Widal Test","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":4,"order":1080,"params":[{"n":"S. Typhi O","t":"option","o":"Below 1:80,1:80,1:160,1:320,1:640","r":[{"x":"Below 1:80"}]},{"n":"S. Typhi H","t":"option","o":"Below 1:80,1:80,1:160,1:320,1:640","r":[{"x":"Below 1:80"}]},{"n":"S. Paratyphi AH","t":"option","o":"Below 1:80,1:80,1:160,1:320,1:640","r":[{"x":"Below 1:80"}]},{"n":"S. Paratyphi BH","t":"option","o":"Below 1:80,1:80,1:160,1:320,1:640","r":[{"x":"Below 1:80"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"DENGNS1","name":"Dengue NS1 Antigen","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":1090,"params":[{"n":"Dengue NS1 antigen","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"DENGAB","name":"Dengue IgM / IgG","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":1100,"params":[{"n":"Dengue IgM","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]},{"n":"Dengue IgG","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HPYS","name":"H. pylori Antibody (Serum)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":1110,"params":[{"n":"H. pylori antibody","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"HPYAG","name":"H. pylori Stool Antigen","dept":"Serology & Immunology","sample":"Stool","container":"Stool container","tat":4,"order":1120,"params":[{"n":"H. pylori stool antigen","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"RA","name":"Rheumatoid Factor (RA)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":4,"order":1130,"params":[{"n":"RA factor","u":"IU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":14}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ASO","name":"ASO Titre","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":4,"order":1140,"params":[{"n":"ASO","u":"IU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":200}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ANA","name":"ANA (Antinuclear Antibody)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":48,"order":1150,"params":[{"n":"ANA","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]},{"n":"Titre / pattern","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"DSDNA","name":"Anti-dsDNA","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":48,"order":1160,"params":[{"n":"Anti-dsDNA","u":"IU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":25}]}]}$j$::jsonb);
select public._seed_test($j${"code":"BRUC","name":"Brucella Antibodies","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":4,"order":1170,"params":[{"n":"Brucella abortus","t":"option","o":"Below 1:80,1:80,1:160,1:320","r":[{"x":"Below 1:80"}]},{"n":"Brucella melitensis","t":"option","o":"Below 1:80,1:80,1:160,1:320","r":[{"x":"Below 1:80"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TBICT","name":"TB Antibody (ICT)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":2,"order":1180,"params":[{"n":"TB IgM","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]},{"n":"TB IgG","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TOXO","name":"Toxoplasma IgG / IgM","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1190,"params":[{"n":"Toxoplasma IgG","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]},{"n":"Toxoplasma IgM","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"RUB","name":"Rubella IgG / IgM","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1200,"params":[{"n":"Rubella IgG","t":"option","o":"Non-reactive,Reactive","r":[]},{"n":"Rubella IgM","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"CMV","name":"CMV IgG / IgM","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1210,"params":[{"n":"CMV IgG","t":"option","o":"Non-reactive,Reactive","r":[]},{"n":"CMV IgM","t":"option","o":"Non-reactive,Reactive","r":[{"x":"Non-reactive"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"TTG","name":"Anti-tTG IgA (Celiac)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":48,"order":1220,"params":[{"n":"Anti-tTG IgA","u":"U/mL","d":1,"r":[{"a0":6570,"lo":0,"hi":20}]}]}$j$::jsonb);
select public._seed_test($j${"code":"IGE","name":"IgE (Total)","dept":"Serology & Immunology","sample":"Serum","container":"Gel / Red","tat":24,"order":1230,"params":[{"n":"Total IgE","u":"IU/mL","d":0,"r":[{"a0":6570,"lo":0,"hi":100}]}]}$j$::jsonb);
select public._seed_test($j${"code":"COVAG","name":"COVID-19 Antigen (Rapid)","dept":"Serology & Immunology","sample":"Nasal swab","container":"Swab","tat":1,"order":1240,"params":[{"n":"SARS-CoV-2 antigen","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"URE","name":"Urine Routine Examination","dept":"Clinical Pathology","sample":"Urine","container":"Sterile container","tat":2,"prep":"First morning, mid-stream urine in the lab container.","order":1250,"params":[{"n":"Colour","t":"option","o":"Pale yellow,Yellow,Dark yellow,Amber,Red,Brown","r":[{"x":"Pale yellow"}],"s":"Physical"},{"n":"Appearance","t":"option","o":"Clear,Slightly turbid,Turbid","r":[{"x":"Clear"}],"s":"Physical"},{"n":"pH","u":"","d":1,"r":[],"s":"Chemical"},{"n":"Specific gravity","u":"","d":3,"r":[],"s":"Chemical"},{"n":"Protein","t":"option","o":"Nil,Trace,+,++,+++,++++","r":[{"x":"Nil"}],"s":"Chemical"},{"n":"Glucose","t":"option","o":"Nil,Trace,+,++,+++,++++","r":[{"x":"Nil"}],"s":"Chemical"},{"n":"Ketones","t":"option","o":"Nil,Trace,+,++,+++,++++","r":[{"x":"Nil"}],"s":"Chemical"},{"n":"Blood","t":"option","o":"Nil,Trace,+,++,+++,++++","r":[{"x":"Nil"}],"s":"Chemical"},{"n":"Bilirubin","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}],"s":"Chemical"},{"n":"Urobilinogen","t":"option","o":"Normal,Increased","r":[{"x":"Normal"}],"s":"Chemical"},{"n":"Nitrite","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}],"s":"Chemical"},{"n":"Leucocyte esterase","t":"option","o":"Nil,Trace,+,++,+++,++++","r":[{"x":"Nil"}],"s":"Chemical"},{"n":"Pus cells","t":"text","r":[{"x":"0 – 5 /HPF"}],"s":"Microscopy"},{"n":"Red blood cells","t":"text","r":[{"x":"0 – 2 /HPF"}],"s":"Microscopy"},{"n":"Epithelial cells","t":"text","r":[{"x":"Few"}],"s":"Microscopy"},{"n":"Casts","t":"text","r":[{"x":"Nil"}],"s":"Microscopy"},{"n":"Crystals","t":"text","r":[{"x":"Nil"}],"s":"Microscopy"},{"n":"Bacteria","t":"text","r":[{"x":"Nil"}],"s":"Microscopy"},{"n":"Others","t":"text","r":[],"s":"Microscopy"}]}$j$::jsonb);
select public._seed_test($j${"code":"UPT","name":"Urine Pregnancy Test","dept":"Clinical Pathology","sample":"Urine","container":"Sterile container","tat":1,"prep":"First morning urine gives the most reliable result.","order":1260,"params":[{"n":"Urine β-hCG","t":"option","o":"Negative,Positive","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"SRE","name":"Stool Routine Examination","dept":"Clinical Pathology","sample":"Stool","container":"Stool container","tat":3,"order":1270,"params":[{"n":"Colour","t":"option","o":"Brown,Yellow,Green,Black,Clay,Red","r":[{"x":"Brown"}],"s":"Physical"},{"n":"Consistency","t":"option","o":"Formed,Semi-formed,Loose,Watery,Mucoid","r":[{"x":"Formed"}],"s":"Physical"},{"n":"Mucus","t":"option","o":"Absent,Present","r":[{"x":"Absent"}],"s":"Physical"},{"n":"Blood","t":"option","o":"Absent,Present","r":[{"x":"Absent"}],"s":"Physical"},{"n":"Pus cells","t":"text","r":[{"x":"Nil"}],"s":"Microscopy"},{"n":"Red blood cells","t":"text","r":[{"x":"Nil"}],"s":"Microscopy"},{"n":"Ova","t":"text","r":[{"x":"Not seen"}],"s":"Microscopy"},{"n":"Cysts","t":"text","r":[{"x":"Not seen"}],"s":"Microscopy"},{"n":"Trophozoites","t":"text","r":[{"x":"Not seen"}],"s":"Microscopy"},{"n":"Others","t":"text","r":[],"s":"Microscopy"}]}$j$::jsonb);
select public._seed_test($j${"code":"FOB","name":"Stool Occult Blood","dept":"Clinical Pathology","sample":"Stool","container":"Stool container","tat":3,"order":1280,"params":[{"n":"Occult blood","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"SEMEN","name":"Semen Analysis","dept":"Clinical Pathology","sample":"Semen","container":"Sterile container","tat":4,"prep":"2 to 7 days of abstinence. Collect the whole sample in the lab container and bring it within 30 minutes, kept at body temperature.","note":"Lower reference limits: WHO laboratory manual (6th edition, 2021).","order":1290,"auto":false,"params":[{"n":"Volume","u":"mL","d":1,"r":[{"a0":6570,"lo":1.4}],"s":"Physical"},{"n":"Liquefaction","t":"option","o":"Complete within 60 min,Incomplete","r":[{"x":"Complete within 60 min"}],"s":"Physical"},{"n":"pH","u":"","d":1,"r":[{"a0":6570,"lo":7.2,"hi":8}],"s":"Physical"},{"n":"Sperm concentration","u":"million/mL","d":0,"r":[{"a0":6570,"lo":16}],"s":"Sperm count"},{"n":"Total sperm count","u":"million/ejaculate","d":0,"r":[{"a0":6570,"lo":39}],"s":"Sperm count"},{"n":"Total motility (PR + NP)","u":"%","d":0,"r":[{"a0":6570,"lo":42}],"s":"Motility"},{"n":"Progressive motility (PR)","u":"%","d":0,"r":[{"a0":6570,"lo":30}],"s":"Motility"},{"n":"Non-progressive (NP)","u":"%","d":0,"r":[],"s":"Motility"},{"n":"Immotile","u":"%","d":0,"r":[],"s":"Motility"},{"n":"Normal forms","u":"%","d":0,"r":[{"a0":6570,"lo":4}],"s":"Morphology"},{"n":"Vitality","u":"%","d":0,"r":[{"a0":6570,"lo":54}],"s":"Morphology"},{"n":"Pus cells","t":"text","r":[],"s":"Other cells"},{"n":"Comment","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"CSF","name":"CSF Analysis","dept":"Clinical Pathology","sample":"CSF","container":"Sterile container","tat":4,"order":1300,"auto":false,"params":[{"n":"Appearance","t":"text","r":[{"x":"Clear, colourless"}]},{"n":"Total cells","u":"/µL","d":0,"r":[{"a0":6570,"lo":0,"hi":5}]},{"n":"Differential","t":"text","r":[]},{"n":"Protein","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":15,"hi":45}]},{"n":"Glucose","u":"mg/dL","d":0,"r":[{"a0":6570,"lo":40,"hi":70}]},{"n":"Gram stain","t":"text","r":[]},{"n":"Comment","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"FLUID","name":"Body Fluid Analysis (Pleural / Ascitic)","dept":"Clinical Pathology","sample":"Body fluid","container":"Sterile container","tat":6,"order":1310,"auto":false,"params":[{"n":"Type of fluid","t":"text","r":[]},{"n":"Appearance","t":"text","r":[]},{"n":"Total cells","u":"/µL","d":0,"r":[]},{"n":"Differential","t":"text","r":[]},{"n":"Protein","u":"g/dL","d":1,"r":[]},{"n":"Glucose","u":"mg/dL","d":0,"r":[]},{"n":"LDH","u":"U/L","d":0,"r":[]},{"n":"Comment","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"UCS","name":"Urine Culture & Sensitivity","dept":"Microbiology","sample":"Urine","container":"Sterile container","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab. Mid-stream urine.","kind":"culture","order":1320,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"BCS","name":"Blood Culture & Sensitivity","dept":"Microbiology","sample":"Blood","container":"Blood culture bottle","tat":120,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1330,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"PCS","name":"Pus / Wound Culture & Sensitivity","dept":"Microbiology","sample":"Pus / swab","container":"Sterile swab","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1340,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"SCS","name":"Stool Culture & Sensitivity","dept":"Microbiology","sample":"Stool","container":"Stool container","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1350,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"SPCS","name":"Sputum Culture & Sensitivity","dept":"Microbiology","sample":"Sputum","container":"Sterile container","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab. Early-morning deep cough sputum, not saliva.","kind":"culture","order":1360,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"HVS","name":"High Vaginal Swab Culture & Sensitivity","dept":"Microbiology","sample":"HVS","container":"Sterile swab","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1370,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"TSCS","name":"Throat Swab Culture & Sensitivity","dept":"Microbiology","sample":"Throat swab","container":"Sterile swab","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1380,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"FCS","name":"Fluid Culture & Sensitivity","dept":"Microbiology","sample":"Body fluid","container":"Sterile container","tat":72,"prep":"Collect before starting antibiotics. Use the sterile container given by the lab.","kind":"culture","order":1390,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"GRAM","name":"Gram Stain","dept":"Microbiology","sample":"As sent","container":"Sterile container","tat":2,"order":1400,"auto":false,"params":[{"n":"Gram stain","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"AFB","name":"AFB Smear (ZN Stain)","dept":"Microbiology","sample":"Sputum","container":"Sterile container","tat":24,"prep":"Two early-morning sputum samples on consecutive days.","order":1410,"auto":false,"params":[{"n":"Acid-fast bacilli","t":"option","o":"Not seen,Scanty,1+,2+,3+","r":[{"x":"Not seen"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"KOH","name":"KOH Mount (Fungus)","dept":"Microbiology","sample":"Skin / nail / hair","container":"Sterile container","tat":4,"order":1420,"params":[{"n":"Fungal elements","t":"option","o":"Not seen,Seen","r":[{"x":"Not seen"}]},{"n":"Comment","t":"text","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"GENEX","name":"GeneXpert MTB/RIF","dept":"Molecular","sample":"Sputum","container":"Sterile container","tat":48,"order":1430,"auto":false,"params":[{"n":"MTB","t":"option","o":"Not detected,Detected (very low),Detected (low),Detected (medium),Detected (high)","r":[{"x":"Not detected"}]},{"n":"Rifampicin resistance","t":"option","o":"Not detected,Detected,Indeterminate","r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"HCVPCR","name":"HCV RNA PCR (Quantitative)","dept":"Molecular","sample":"Plasma","container":"EDTA (purple)","tat":96,"order":1440,"auto":false,"params":[{"n":"HCV RNA","t":"text","r":[{"x":"Not detected"}]},{"n":"Viral load","u":"IU/mL","d":0,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"HBVPCR","name":"HBV DNA PCR (Quantitative)","dept":"Molecular","sample":"Plasma","container":"EDTA (purple)","tat":96,"order":1450,"auto":false,"params":[{"n":"HBV DNA","t":"text","r":[{"x":"Not detected"}]},{"n":"Viral load","u":"IU/mL","d":0,"r":[]}]}$j$::jsonb);
select public._seed_test($j${"code":"HISTS","name":"Histopathology (Small Biopsy)","dept":"Histopathology & Cytology","sample":"Tissue in formalin","container":"Formalin container","tat":120,"kind":"text","order":1460,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"HISTL","name":"Histopathology (Large Specimen)","dept":"Histopathology & Cytology","sample":"Tissue in formalin","container":"Formalin container","tat":168,"kind":"text","order":1470,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"PAP","name":"Pap Smear (Cervical Cytology)","dept":"Histopathology & Cytology","sample":"Cervical smear","container":"Slide","tat":72,"kind":"text","order":1480,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"FNAC","name":"FNAC","dept":"Histopathology & Cytology","sample":"Aspirate","container":"Slides","tat":72,"kind":"text","order":1490,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"FCYTO","name":"Fluid Cytology","dept":"Histopathology & Cytology","sample":"Body fluid","container":"Sterile container","tat":72,"kind":"text","order":1500,"auto":false,"params":[]}$j$::jsonb);
select public._seed_test($j${"code":"XM","name":"Cross Match","dept":"Blood Bank","sample":"Whole blood","container":"EDTA (purple)","tat":2,"order":1510,"auto":false,"params":[{"n":"Donor bag / unit no.","t":"text","r":[]},{"n":"Donor group","t":"option","o":"A+,A-,B+,B-,AB+,AB-,O+,O-","r":[]},{"n":"Cross match","t":"option","o":"Compatible,Incompatible","r":[{"x":"Compatible"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"DCT","name":"Direct Coombs Test","dept":"Blood Bank","sample":"Whole blood","container":"EDTA (purple)","tat":3,"order":1520,"params":[{"n":"Direct Coombs (DAT)","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_test($j${"code":"ICT","name":"Indirect Coombs Test","dept":"Blood Bank","sample":"Serum","container":"Gel / Red","tat":4,"order":1530,"params":[{"n":"Indirect Coombs (IAT)","t":"option","o":"Negative,Positive","r":[{"x":"Negative"}]}]}$j$::jsonb);
select public._seed_package('PKG-FULL', 'Full Body Checkup', 5000, array['CBC','ESR','LFT','RFT','LIPID','BSF','HBA1C','TSH','URE','VITD','B12']);
select public._seed_package('PKG-DM', 'Diabetes Profile', 5001, array['BSF','HBA1C','RFT','LIPID','MALB','URE']);
select public._seed_package('PKG-CARD', 'Cardiac Profile', 5002, array['LIPID','CKMB','TROPI','HSCRP']);
select public._seed_package('PKG-FEVER', 'Fever Profile', 5003, array['CBC','MP','TYPHI','URE','CRP','DENGNS1']);
select public._seed_package('PKG-PREOP', 'Pre-operative Profile', 5004, array['CBC','PT','APTT','BG','HBSAG','HCV','HIV','BSR','RFT']);
select public._seed_package('PKG-ANC', 'Antenatal Profile', 5005, array['CBC','BG','HBSAG','HCV','HIV','VDRL','URE','BSR','TSH']);
select public._seed_package('PKG-LIVER', 'Liver Profile', 5006, array['LFT','HBSAG','HCV','PT']);
select public._seed_package('PKG-THY', 'Thyroid Complete', 5007, array['TFTF','ATPO']);
select public._seed_package('PKG-ANEM', 'Anaemia Profile', 5008, array['CBC','RETIC','PS','IRON','B12','FOL']);
select public._seed_package('PKG-FERT', 'Female Hormone Profile', 5009, array['LH','FSH','PRL','E2','TSH','AMH']);
insert into public.antibiotics (name, class, sort_order) values
  ('Ampicillin', 'Penicillins', 1),
  ('Amoxicillin-clavulanate', 'Penicillins', 2),
  ('Piperacillin-tazobactam', 'Penicillins', 3),
  ('Cefazolin', 'Cephalosporins', 4),
  ('Cefuroxime', 'Cephalosporins', 5),
  ('Ceftriaxone', 'Cephalosporins', 6),
  ('Cefixime', 'Cephalosporins', 7),
  ('Ceftazidime', 'Cephalosporins', 8),
  ('Cefepime', 'Cephalosporins', 9),
  ('Cefoperazone-sulbactam', 'Cephalosporins', 10),
  ('Imipenem', 'Carbapenems', 11),
  ('Meropenem', 'Carbapenems', 12),
  ('Ertapenem', 'Carbapenems', 13),
  ('Aztreonam', 'Monobactams', 14),
  ('Gentamicin', 'Aminoglycosides', 15),
  ('Amikacin', 'Aminoglycosides', 16),
  ('Ciprofloxacin', 'Fluoroquinolones', 17),
  ('Levofloxacin', 'Fluoroquinolones', 18),
  ('Moxifloxacin', 'Fluoroquinolones', 19),
  ('Trimethoprim-sulfamethoxazole', 'Folate inhibitors', 20),
  ('Nitrofurantoin', 'Urinary agents', 21),
  ('Fosfomycin', 'Urinary agents', 22),
  ('Azithromycin', 'Macrolides', 23),
  ('Erythromycin', 'Macrolides', 24),
  ('Clarithromycin', 'Macrolides', 25),
  ('Clindamycin', 'Lincosamides', 26),
  ('Doxycycline', 'Tetracyclines', 27),
  ('Tetracycline', 'Tetracyclines', 28),
  ('Minocycline', 'Tetracyclines', 29),
  ('Tigecycline', 'Glycylcyclines', 30),
  ('Vancomycin', 'Glycopeptides', 31),
  ('Teicoplanin', 'Glycopeptides', 32),
  ('Linezolid', 'Oxazolidinones', 33),
  ('Oxacillin / Cefoxitin (MRSA screen)', 'Penicillins', 34),
  ('Penicillin', 'Penicillins', 35),
  ('Colistin', 'Polymyxins', 36),
  ('Polymyxin B', 'Polymyxins', 37),
  ('Chloramphenicol', 'Phenicols', 38),
  ('Fusidic acid', 'Others', 39),
  ('Rifampicin', 'Others', 40),
  ('Metronidazole', 'Nitroimidazoles', 41)
on conflict do nothing;
insert into public.report_templates (name, body) values
  ('Histopathology — standard', 'SPECIMEN:

CLINICAL DETAILS:

GROSS DESCRIPTION:

MICROSCOPIC DESCRIPTION:

DIAGNOSIS:

COMMENT:
'),
  ('Pap smear (Bethesda)', 'SPECIMEN ADEQUACY: Satisfactory for evaluation; endocervical/transformation zone component present.

GENERAL CATEGORISATION: Negative for intraepithelial lesion or malignancy.

INTERPRETATION / RESULT:

COMMENT:
'),
  ('FNAC — standard', 'SITE:

CLINICAL DETAILS:

ASPIRATE:

MICROSCOPY:

DIAGNOSIS:
'),
  ('Fluid cytology', 'FLUID TYPE:

GROSS:

MICROSCOPY:

IMPRESSION: Negative for malignant cells.
'),
  ('Peripheral smear comment', 'RBC: 
WBC: 
Platelets: 
Impression: 
')
on conflict do nothing;
update public.lab_tests t set template_id = r.id from public.report_templates r
 where t.template_id is null and ((t.code in ('HISTS','HISTL') and r.name = 'Histopathology — standard')
   or (t.code = 'PAP' and r.name = 'Pap smear (Bethesda)') or (t.code = 'FNAC' and r.name = 'FNAC — standard')
   or (t.code = 'FCYTO' and r.name = 'Fluid cytology'));

drop function if exists public._seed_test(jsonb);
drop function if exists public._seed_package(text, text, int, text[]);
drop function if exists public._pol(text,text,text,text,text);

-- =====================================================================
-- End of final_supabase.sql
-- =====================================================================
