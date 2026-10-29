create table if not exists public.lawyers (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique check (length(trim(name::text)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.municipalities (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique check (length(trim(name::text)) > 0),
  created_at timestamptz not null default now()
);

alter table public.documents
  add column if not exists lawyer_id uuid references public.lawyers(id) on delete restrict;

insert into public.municipalities (name) values
  ('ABASOLO'), ('AGUALEGUAS'), ('LOS ALDAMAS'), ('ALLENDE'), ('ANÁHUAC'),
  ('APODACA'), ('ARAMBERRI'), ('BUSTAMANTE'), ('CADEREYTA JIMÉNEZ'), ('EL CARMEN'),
  ('CERRALVO'), ('CIÉNEGA DE FLORES'), ('CHINA'), ('DOCTOR ARROYO'), ('DOCTOR COSS'),
  ('DOCTOR GONZÁLEZ'), ('GALEANA'), ('GARCÍA'), ('SAN PEDRO GARZA GARCÍA'),
  ('GENERAL BRAVO'), ('GENERAL ESCOBEDO'), ('GENERAL TERÁN'), ('GENERAL TREVIÑO'),
  ('GENERAL ZARAGOZA'), ('GENERAL ZUAZUA'), ('GUADALUPE'), ('LOS HERRERAS'),
  ('HIDALGO'), ('HIGUERAS'), ('HUALAHUISES'), ('ITURBIDE'), ('JUÁREZ'),
  ('LAMPAZOS DE NARANJO'), ('LINARES'), ('MARÍN'), ('MELCHOR OCAMPO'),
  ('MIER Y NORIEGA'), ('MINA'), ('MONTEMORELOS'), ('MONTERREY'), ('PARÁS'),
  ('PESQUERÍA'), ('LOS RAMONES'), ('RAYONES'), ('SABINAS HIDALGO'),
  ('SALINAS VICTORIA'), ('SAN NICOLÁS DE LOS GARZA'), ('SANTA CATARINA'),
  ('SANTIAGO'), ('VALLECILLO'), ('VILLALDAMA')
on conflict (name) do nothing;

alter table public.lawyers enable row level security;
alter table public.municipalities enable row level security;

drop policy if exists "authenticated_lawyers" on public.lawyers;
create policy "authenticated_lawyers" on public.lawyers
for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_municipalities" on public.municipalities;
create policy "authenticated_municipalities" on public.municipalities
for all to authenticated using (true) with check (true);

revoke all on public.lawyers, public.municipalities from anon;
grant select, insert, delete on public.lawyers, public.municipalities to authenticated;
