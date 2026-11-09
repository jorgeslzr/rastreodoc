-- Permite que cualquier usuario autenticado restaure un documento archivado.
create or replace function public.restore_archived_document(target_document_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sesión requerida.';
  end if;

  update public.documents
  set archived_at = null
  where id = target_document_id
    and archived_at is not null;

  return found;
end;
$$;

revoke all on function public.restore_archived_document(uuid) from public;
grant execute on function public.restore_archived_document(uuid) to authenticated;
