-- Solo lectura: ejecutar después de instalar 20261113_delete_archived_document.sql.
-- No elimina ni modifica documentos.
select
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='delete_archived_document'
      and p.pronargs=6 and p.prosecdef
  ) as eliminacion_disponible,
  exists (
    select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where t.tgrelid='public.movements'::regclass
      and t.tgname='movements_are_immutable' and t.tgenabled='O' and p.prosecdef
  ) as historial_protegido,
  case when to_regclass('public.document_deletion_receipts') is null then false
    else not has_table_privilege('authenticated', 'public.document_deletion_receipts', 'INSERT')
      and not has_table_privilege('authenticated', 'public.document_deletion_receipts', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.document_deletion_receipts', 'DELETE')
      and not has_table_privilege('authenticated', 'public.document_deletion_receipts', 'SELECT')
  end as confirmaciones_privadas;
