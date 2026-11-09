-- Safe repair for installations where case_files.auxiliary never existed.
-- This script intentionally does not reference that legacy column.
create table if not exists public.auxiliaries (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique check (length(trim(name::text)) > 0),
  created_at timestamptz not null default now()
);

alter table public.documents
  add column if not exists auxiliary_id uuid references public.auxiliaries(id) on delete restrict;

create index if not exists documents_auxiliary_id_idx on public.documents(auxiliary_id);

alter table public.auxiliaries enable row level security;
drop policy if exists "authenticated_auxiliaries" on public.auxiliaries;
create policy "authenticated_auxiliaries" on public.auxiliaries
for all to authenticated using (true) with check (true);

revoke all on public.auxiliaries from anon;
grant select, insert, delete on public.auxiliaries to authenticated;

notify pgrst, 'reload schema';
