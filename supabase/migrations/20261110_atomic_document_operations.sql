-- Guardados de documentos atómicos, con detección de conflictos e idempotencia.
-- Aplicar primero a una base de pruebas. No modifica el historial existente.
-- Desplegar con la oficina cerrada: primero esta migración y después el cliente.
-- Las pestañas antiguas deberán recargarse para poder registrar movimientos.

begin;

-- Una confirmación por solicitud, sin duplicar notas ni otros datos de captura.
-- El hash sirve para detectar la reutilización de un identificador con otra carga.
create table if not exists public.document_operation_receipts (
  operation_id uuid primary key,
  document_id uuid not null references public.documents(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  request_fingerprint text not null,
  recorded_status public.document_status,
  created_at timestamptz not null default now()
);

create index if not exists document_operation_receipts_document_idx
  on public.document_operation_receipts(document_id);

alter table public.document_operation_receipts enable row level security;
revoke all on public.document_operation_receipts from public, anon, authenticated;

-- Las versiones anteriores insertaban movements directamente y podían eludir
-- la comprobación de concurrencia. Pedirles recargar evita aceptar ese guardado.
-- El movimiento inicial se ejecuta dentro del trigger de creación de documents.
create or replace function public.require_document_operation_rpc()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  operation_context jsonb;
  raw_context text := nullif(current_setting('rastreadoc.document_operation', true), '');
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if current_user <> 'authenticated' and auth.uid() is null then
    return new;
  end if;

  -- Dentro de la RPC, current_user es su propietario (SECURITY DEFINER).
  -- Un INSERT directo de authenticated no puede autorizarse copiando el GUC.
  if current_user <> 'authenticated' and raw_context is not null then
    begin
      operation_context := raw_context::jsonb;
    exception when invalid_text_representation then
      operation_context := null;
    end;

    if nullif(operation_context ->> 'operation_id', '') is not null
      and operation_context ->> 'document_id' = new.document_id::text
      and new.created_by is not distinct from auth.uid() then
      return new;
    end if;
  end if;

  raise sqlstate 'PT409'
    using message = 'Actualiza la aplicación antes de registrar movimientos.';
end;
$$;

drop trigger if exists movements_require_operation_rpc on public.movements;
create trigger movements_require_operation_rpc
before insert on public.movements
for each row execute function public.require_document_operation_rpc();

-- La corrección antigua actualizaba la etiqueta antes de insertar el movimiento.
-- Rechazar ese primer paso evita una corrección parcial al bloquear después el
-- INSERT legado. El archivado y la restauración no cambian estos tres campos.
create or replace function public.require_document_operation_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and (
    new.label is distinct from old.label
    or new.status is distinct from old.status
    or new.last_movement_at is distinct from old.last_movement_at
  ) then
    raise sqlstate 'PT409'
      using message = 'Actualiza la aplicación antes de corregir documentos.';
  end if;
  return new;
end;
$$;

drop trigger if exists documents_require_operation_rpc on public.documents;
create trigger documents_require_operation_rpc
before update of label, status, last_movement_at on public.documents
for each row execute function public.require_document_operation_update();

create or replace function public.save_document_operation(
  p_operation_id uuid,
  p_document_id uuid,
  p_expected_status public.document_status,
  p_expected_movement_at timestamptz,
  p_expected_label text,
  p_requested_status public.document_status default null,
  p_change_label boolean default false,
  p_label text default null,
  p_receipt_number text default null,
  p_rejection_reason text default null,
  p_notes text default null,
  p_is_correction boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  actor uuid := auth.uid();
  current_document public.documents%rowtype;
  prior_receipt public.document_operation_receipts%rowtype;
  request_fingerprint text;
  resolved_status public.document_status := p_requested_status;
  clean_label text := nullif(btrim(p_label), '');
  clean_receipt text := nullif(btrim(p_receipt_number), '');
  clean_rejection text := nullif(btrim(p_rejection_reason), '');
  clean_notes text := nullif(btrim(p_notes), '');
  label_changed boolean;
  status_changed boolean;
  is_isai boolean;
  previous_operation_context text := current_setting(
    'rastreadoc.document_operation', true
  );
begin
  if actor is null then
    raise sqlstate 'PT401' using message = 'Sesión requerida. Inicia sesión para guardar.';
  end if;

  if p_operation_id is null or p_document_id is null
    or p_expected_status is null or p_expected_movement_at is null
    or p_change_label is null or p_is_correction is null then
    raise sqlstate 'PT422' using message = 'Faltan datos para comprobar y guardar la operación.';
  end if;

  request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'document_id', p_document_id,
    'expected_status', p_expected_status,
    'expected_movement_at', p_expected_movement_at,
    'expected_label', p_expected_label,
    'requested_status', p_requested_status,
    'change_label', p_change_label,
    'label', p_label,
    'receipt_number', p_receipt_number,
    'rejection_reason', p_rejection_reason,
    'notes', p_notes,
    'is_correction', p_is_correction
  )::text, 'UTF8')), 'hex');

  -- El bloqueo incluye la comprobación de estado, la clasificación del envío,
  -- la etiqueta, el movimiento y su confirmación en una sola transacción.
  select * into current_document
  from public.documents
  where id = p_document_id
  for update;

  if not found then
    raise sqlstate 'PT409' using message = 'El documento ya no está disponible. Actualiza la consulta.';
  end if;

  select * into prior_receipt
  from public.document_operation_receipts
  where operation_id = p_operation_id;

  if found then
    if prior_receipt.actor_id is distinct from actor
      or prior_receipt.document_id is distinct from p_document_id
      or prior_receipt.request_fingerprint is distinct from request_fingerprint then
      raise sqlstate 'PT409' using message = 'El identificador de esta operación ya se utilizó para otra solicitud.';
    end if;

    -- El documento pudo cambiar desde la primera confirmación. Devolver su
    -- estado actual evita que un reintento haga retroceder la pantalla.
    return jsonb_build_object(
      'document', jsonb_build_object(
        'id', current_document.id,
        'status', current_document.status,
        'last_movement_at', current_document.last_movement_at,
        'label', current_document.label,
        'archived_at', current_document.archived_at
      ),
      'recorded_status', prior_receipt.recorded_status,
      'duplicate', true
    );
  end if;

  if current_document.archived_at is not null then
    raise sqlstate 'PT409' using message = 'El documento fue archivado. Actualiza la consulta antes de continuar.';
  end if;

  if current_document.status is distinct from p_expected_status
    or current_document.last_movement_at is distinct from p_expected_movement_at
    or current_document.label is distinct from p_expected_label then
    raise sqlstate 'PT409' using message = 'El documento cambió desde que lo consultaste. Actualiza su información antes de guardar.';
  end if;

  if (p_change_label and length(clean_label) > 120)
    or length(clean_receipt) > 100 or length(clean_rejection) > 250 then
    raise sqlstate 'PT422' using message = 'La etiqueta, la boleta o el motivo exceden la longitud permitida.';
  end if;

  label_changed := p_change_label and clean_label is distinct from current_document.label;

  if not p_is_correction and p_requested_status in ('ENVIADO', 'REENVIADO') then
    if current_document.status in ('ENVIADO', 'REENVIADO') then
      raise sqlstate 'PT422' using message = 'El documento ya está enviado. Revisa su historial antes de registrar otro envío.';
    end if;

    select upper(btrim(name::text)) = 'ISAI' into is_isai
    from public.document_types
    where id = current_document.document_type_id;

    if not coalesce(is_isai, false) and clean_receipt is null then
      raise sqlstate 'PT422' using message = 'Escribe el número de boleta antes de registrar el envío.';
    end if;

    if exists (
      select 1 from public.movements
      where document_id = p_document_id and status in ('ENVIADO', 'REENVIADO')
    ) then
      resolved_status := 'REENVIADO';
    else
      resolved_status := 'ENVIADO';
    end if;
  end if;

  status_changed := resolved_status is not null
    and resolved_status is distinct from current_document.status;

  if not label_changed and not status_changed then
    raise sqlstate 'PT422' using message = 'El documento ya tiene estos datos. No se registró otro movimiento.';
  end if;

  if label_changed then
    update public.documents
    set label = clean_label
    where id = p_document_id;
  end if;

  if status_changed then
    perform set_config('rastreadoc.document_operation', jsonb_build_object(
      'operation_id', p_operation_id,
      'document_id', p_document_id
    )::text, true);
    begin
      insert into public.movements (
        document_id, status, occurred_at, receipt_number, rejection_reason, notes, created_by
      ) values (
        p_document_id,
        resolved_status,
        greatest(clock_timestamp(), current_document.last_movement_at + interval '1 microsecond'),
        case when resolved_status in ('ENVIADO', 'REENVIADO') then clean_receipt else null end,
        case when resolved_status = 'RECHAZADO' then clean_rejection else null end,
        clean_notes,
        actor
      );
    exception when others then
      perform set_config('rastreadoc.document_operation', coalesce(previous_operation_context, ''), true);
      raise;
    end;
    perform set_config('rastreadoc.document_operation', coalesce(previous_operation_context, ''), true);
  end if;

  insert into public.document_operation_receipts (
    operation_id, document_id, actor_id, request_fingerprint, recorded_status
  ) values (
    p_operation_id, p_document_id, actor, request_fingerprint,
    case when status_changed then resolved_status else null end
  );

  -- El trigger de movements mantiene status y last_movement_at. Leer la fila
  -- después del INSERT devuelve exactamente la confirmación del servidor.
  select * into current_document
  from public.documents
  where id = p_document_id;

  return jsonb_build_object(
    'document', jsonb_build_object(
      'id', current_document.id,
      'status', current_document.status,
      'last_movement_at', current_document.last_movement_at,
      'label', current_document.label,
      'archived_at', current_document.archived_at
    ),
    'recorded_status', case when status_changed then resolved_status else null end,
    'duplicate', false
  );
exception
  when unique_violation then
    -- También protege contra reutilizar simultáneamente un operation_id para
    -- documentos distintos. Este bloque revierte toda la operación antes de fallar.
    raise sqlstate 'PT409' using message = 'El identificador de esta operación ya se utilizó para otra solicitud.';
end;
$$;

revoke all on function public.save_document_operation(
  uuid, uuid, public.document_status, timestamptz, text, public.document_status,
  boolean, text, text, text, text, boolean
) from public, anon;

grant execute on function public.save_document_operation(
  uuid, uuid, public.document_status, timestamptz, text, public.document_status,
  boolean, text, text, text, text, boolean
) to authenticated;

commit;
