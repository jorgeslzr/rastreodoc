-- Eliminación definitiva individual desde Archivados. Instalar primero en pruebas.
-- Instalar esta migración NO elimina documentos. Solo una llamada confirmada lo hace.
begin;

do $$
begin
  if to_regclass('public.document_operation_receipts') is null or not exists (
    select 1 from pg_trigger where tgrelid = 'public.movements'::regclass
      and tgname = 'movements_are_immutable' and tgenabled = 'O'
  ) then
    raise exception 'Falta la configuración anterior de documentos e historial. No se instaló la eliminación.';
  end if;
end;
$$;

-- Constancia mínima para verificar reintentos: no conserva el documento ni su historial.
-- Sin FK al documento: la confirmación debe sobrevivir a la eliminación.
create table if not exists public.document_deletion_receipts (
  operation_id uuid primary key,
  document_id uuid not null,
  actor_id uuid not null,
  request_fingerprint text not null,
  deletion_transaction bigint not null,
  completed boolean not null default false,
  deleted_movements bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.document_deletion_receipts enable row level security;
revoke all on public.document_deletion_receipts from public, anon, authenticated;
create index if not exists document_deletion_receipts_active_idx
  on public.document_deletion_receipts(document_id, deletion_transaction) where not completed;

-- La única excepción es el borrado del documento confirmado en ESTA transacción.
-- Un cliente no puede fabricar la constancia privada ni habilitarla con un GUC.
create or replace function public.prevent_movement_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and exists (
    select 1 from public.document_deletion_receipts
    where document_id = old.document_id and actor_id = auth.uid()
      and deletion_transaction = txid_current() and not completed
  ) then
    return old;
  end if;
  raise exception 'El historial de movimientos no se puede modificar ni eliminar.';
end;
$$;
revoke all on function public.prevent_movement_changes() from public, anon, authenticated;

create or replace function public.delete_archived_document(
  p_operation_id uuid,
  p_document_id uuid,
  p_expected_archived_at timestamptz,
  p_expected_movement_at timestamptz,
  p_expected_label text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
set lock_timeout = '5s'
as $$
declare
  actor uuid := auth.uid();
  target public.documents%rowtype;
  prior public.document_deletion_receipts%rowtype;
  fingerprint text;
  movement_count bigint;
begin
  if actor is null then
    raise sqlstate 'PT401' using message = 'Sesión requerida para eliminar.';
  end if;
  if not exists (select 1 from public.profiles where id = actor and role in ('admin', 'supervisor')) then
    raise sqlstate '42501' using message = 'Solo administradores y supervisores pueden eliminar definitivamente.';
  end if;
  if p_operation_id is null or p_document_id is null
    or p_expected_archived_at is null or p_expected_movement_at is null
    or p_confirmation is distinct from 'ELIMINAR' then
    raise sqlstate 'PT422' using message = 'Revisa el documento archivado y escribe ELIMINAR para confirmar.';
  end if;

  fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'document_id', p_document_id, 'archived_at', p_expected_archived_at,
    'movement_at', p_expected_movement_at, 'label', p_expected_label
  )::text, 'UTF8')), 'hex');

  -- Serializar también la primera llamada: una respuesta perdida se puede verificar
  -- con el mismo ID aunque el documento ya no exista.
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  select * into prior from public.document_deletion_receipts where operation_id = p_operation_id;
  if found then
    if prior.actor_id is distinct from actor or prior.document_id is distinct from p_document_id
      or prior.request_fingerprint is distinct from fingerprint or not prior.completed then
      raise sqlstate 'PT409' using message = 'La solicitud no coincide con la eliminación confirmada.';
    end if;
    return jsonb_build_object('operation_id', p_operation_id, 'document_id', p_document_id,
      'deleted', true, 'duplicate', true);
  end if;

  select * into target from public.documents where id = p_document_id for update;
  if not found then
    raise sqlstate 'PT409' using message = 'El documento ya no está disponible. Revisa Archivados.';
  end if;
  if target.archived_at is null or target.archived_at is distinct from p_expected_archived_at
    or target.last_movement_at is distinct from p_expected_movement_at
    or target.label is distinct from p_expected_label then
    raise sqlstate 'PT409' using message = 'El documento cambió o fue restaurado. Revisa su información antes de eliminar.';
  end if;

  insert into public.document_deletion_receipts
    (operation_id, document_id, actor_id, request_fingerprint, deletion_transaction)
  values (p_operation_id, p_document_id, actor, fingerprint, txid_current());

  delete from public.movements where document_id = p_document_id;
  get diagnostics movement_count = row_count;
  delete from public.document_operation_receipts where document_id = p_document_id;
  delete from public.documents where id = p_document_id;
  if not found then
    raise exception 'No se pudo completar la eliminación del documento.';
  end if;
  update public.document_deletion_receipts
  set completed = true, deleted_movements = movement_count where operation_id = p_operation_id;

  return jsonb_build_object('operation_id', p_operation_id, 'document_id', p_document_id,
    'deleted', true, 'duplicate', false);
end;
$$;

revoke all on function public.delete_archived_document(uuid, uuid, timestamptz, timestamptz, text, text)
  from public, anon;
grant execute on function public.delete_archived_document(uuid, uuid, timestamptz, timestamptz, text, text)
  to authenticated;
notify pgrst, 'reload schema';
commit;
