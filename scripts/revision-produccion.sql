-- SOLO LECTURA: revisar la base de la oficina antes de la actualización.
-- Consulta estructura y automatismos; no lee expedientes ni modifica datos.
with columnas_necesarias(esquema, tabla, columna, tipos) as (
  values
    ('public', 'documents', 'id', array['uuid']),
    ('public', 'documents', 'document_type_id', array['uuid']),
    ('public', 'documents', 'status', array['document_status']),
    ('public', 'documents', 'last_movement_at', array['timestamptz']),
    ('public', 'documents', 'archived_at', array['timestamptz']),
    ('public', 'documents', 'label', array['text', 'varchar']),
    ('public', 'document_types', 'id', array['uuid']),
    ('public', 'document_types', 'name', array['citext', 'text', 'varchar']),
    ('public', 'movements', 'document_id', array['uuid']),
    ('public', 'movements', 'status', array['document_status']),
    ('public', 'movements', 'occurred_at', array['timestamptz']),
    ('public', 'movements', 'receipt_number', array['text', 'varchar']),
    ('public', 'movements', 'rejection_reason', array['text', 'varchar']),
    ('public', 'movements', 'notes', array['text', 'varchar']),
    ('public', 'movements', 'created_by', array['uuid']),
    ('auth', 'users', 'id', array['uuid'])
), columnas_pendientes as (
  select n.esquema || '.' || n.tabla || '.' || n.columna as nombre
  from columnas_necesarias n
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = n.esquema and c.table_name = n.tabla
      and c.column_name = n.columna and c.udt_name = any(n.tipos)
      and (c.udt_name <> 'document_status' or c.udt_schema = 'public')
  )
), estatus_necesarios(nombre) as (
  values ('EN_OFICINA'), ('ENVIADO'), ('AUTORIZADO'), ('RECHAZADO'), ('REENVIADO')
), estatus_pendientes as (
  select r.nombre from estatus_necesarios r
  where not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'document_status'
      and e.enumlabel = r.nombre
  )
), automatismos_necesarios(tabla, disparador, funcion, eventos) as (
  values
    ('documents', 'document_initial_movement', 'create_initial_movement', 5),
    ('movements', 'movement_sync_document', 'sync_document_status', 5),
    ('movements', 'movements_are_immutable', 'prevent_movement_changes', 27)
), automatismos_pendientes as (
  select r.disparador as nombre from automatismos_necesarios r
  where not exists (
    select 1 from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
    where t.tgrelid = to_regclass('public.' || r.tabla)
      and t.tgname = r.disparador and t.tgtype = r.eventos
      and t.tgenabled in ('O', 'A') and not t.tgisinternal
      and n.nspname = 'public' and p.proname = r.funcion
  )
)
select
  not exists (select 1 from columnas_pendientes) as estructura_compatible,
  not exists (select 1 from estatus_pendientes) as estatus_compatibles,
  not exists (select 1 from automatismos_pendientes) as historial_configurado,
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid' and p.pronargs = 0
      and p.prorettype = 'uuid'::regtype
  ) as autenticacion_disponible,
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'save_document_operation'
      and p.pronargs = 12
  ) as actualizacion_ya_presente,
  jsonb_build_object(
    'columnas', coalesce((select jsonb_agg(nombre order by nombre) from columnas_pendientes), '[]'::jsonb),
    'estatus', coalesce((select jsonb_agg(nombre order by nombre) from estatus_pendientes), '[]'::jsonb),
    'automatismos', coalesce((select jsonb_agg(nombre order by nombre) from automatismos_pendientes), '[]'::jsonb)
  ) as detalle;
