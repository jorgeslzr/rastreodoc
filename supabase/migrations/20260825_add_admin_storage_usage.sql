-- Permite que únicamente los administradores consulten el espacio usado por la base de datos.
create or replace function public.get_database_storage_usage()
returns bigint
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Solo los administradores pueden consultar el almacenamiento.';
  end if;

  return pg_database_size(current_database());
end;
$$;

revoke all on function public.get_database_storage_usage() from public;
grant execute on function public.get_database_storage_usage() to authenticated;
