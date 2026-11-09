create table if not exists public.auxiliaries (
  id uuid primary key default gen_random_uuid(),
  name citext not null unique check (length(trim(name::text)) > 0),
  created_at timestamptz not null default now()
);

alter table public.documents
  add column if not exists auxiliary_id uuid references public.auxiliaries(id) on delete restrict;

create index if not exists documents_auxiliary_id_idx on public.documents(auxiliary_id);

-- Some installations never received the temporary case_files.auxiliary
-- column. Dynamic SQL prevents PostgreSQL from parsing references to that
-- missing column. If it exists, preserve its values before removing it.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'case_files'
      and column_name = 'auxiliary'
  ) then
    execute $migration$
      insert into public.auxiliaries (name)
      select distinct trim(auxiliary)
      from public.case_files
      where auxiliary is not null and length(trim(auxiliary)) > 0
      on conflict (name) do nothing
    $migration$;

    execute $migration$
      update public.documents as document
      set auxiliary_id = auxiliary_record.id
      from public.case_files as case_file
      join public.auxiliaries as auxiliary_record
        on auxiliary_record.name = trim(case_file.auxiliary)
      where document.case_file_id = case_file.id
        and document.auxiliary_id is null
    $migration$;
  end if;
end
$$;

alter table public.case_files drop column if exists auxiliary;

alter table public.auxiliaries enable row level security;
drop policy if exists "authenticated_auxiliaries" on public.auxiliaries;
create policy "authenticated_auxiliaries" on public.auxiliaries
for all to authenticated using (true) with check (true);

revoke all on public.auxiliaries from anon;
grant select, insert, delete on public.auxiliaries to authenticated;

notify pgrst, 'reload schema';
