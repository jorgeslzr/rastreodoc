-- Agrega perfiles simples por usuario para permisos dentro de RASTREADOC.
do $$
begin
  create type public.app_role as enum ('admin', 'supervisor', 'empleado', 'consulta');
exception
  when duplicate_object then null;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username citext not null unique check (length(trim(username::text)) >= 3),
  role public.app_role not null default 'consulta',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "authenticated_profiles_read" on public.profiles;
create policy "authenticated_profiles_read" on public.profiles
for select to authenticated using (true);

revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;
