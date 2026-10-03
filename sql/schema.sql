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

-- @@SEED@@

drop function if exists public._seed_test(jsonb);
drop function if exists public._seed_package(text, text, int, text[]);
drop function if exists public._pol(text,text,text,text,text);

-- =====================================================================
-- End of final_supabase.sql
-- =====================================================================
