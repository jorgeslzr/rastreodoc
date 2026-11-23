begin;

-- Acceso exclusivo para cuentas con perfil autorizado por la oficina.
-- Aplicar después de publicar el servidor que deniega perfiles ausentes.
-- No crea usuarios ni perfiles y no modifica documentos ni su historial.

do $$
begin
  if exists (select 1 from auth.users)
    and not exists (select 1 from public.profiles where role in ('admin', 'supervisor')) then
    raise exception 'No se aplicó el cambio: verifica primero el perfil del administrador de la oficina.';
  end if;
end;
$$;

create or replace function public.current_office_role()
returns text
language sql stable security definer
set search_path = ''
as $$
  select role::text from public.profiles where id = auth.uid()
$$;
revoke all on function public.current_office_role() from public, anon;
grant execute on function public.current_office_role() to authenticated;

-- Las políticas restrictivas se combinan con las políticas existentes mediante
-- AND. Una política permisiva antigua no puede admitir una cuenta sin perfil.
do $$
declare
  target text;
  columns_sql text;
begin
  foreach target in array array['profiles', 'agencies', 'document_types', 'lawyers',
    'auxiliaries', 'municipalities', 'case_files', 'documents', 'movements'] loop
    execute format('alter table public.%I enable row level security', target);
    execute format('revoke all on table public.%I from public, anon, authenticated', target);
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns_sql
    from pg_attribute where attrelid = format('public.%I', target)::regclass
      and attnum > 0 and not attisdropped;
    -- Supabase puede haber concedido privilegios por columna además de tabla.
    execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.%I from public, anon, authenticated',
      columns_sql, columns_sql, columns_sql, columns_sql, target);
    execute format('drop policy if exists office_members_only on public.%I', target);
    execute format('create policy office_members_only on public.%I as restrictive for all to authenticated
      using ((select public.current_office_role()) is not null)
      with check ((select public.current_office_role()) is not null)', target);
    execute format('drop policy if exists office_no_anonymous on public.%I', target);
    execute format('create policy office_no_anonymous on public.%I as restrictive for all to anon using (false) with check (false)', target);
  end loop;
end;
$$;

grant select on public.profiles, public.agencies, public.document_types, public.lawyers,
  public.auxiliaries, public.municipalities, public.case_files, public.documents, public.movements to authenticated;
grant insert on public.agencies, public.document_types, public.lawyers, public.auxiliaries,
  public.municipalities, public.case_files, public.documents, public.movements to authenticated;
grant delete on public.agencies, public.document_types, public.lawyers, public.auxiliaries,
  public.municipalities to authenticated;
grant update (archived_at) on public.documents to authenticated;
revoke all on sequence public.movements_id_seq from public, anon;
grant usage, select on sequence public.movements_id_seq to authenticated;

-- El servicio administrativo conserva los permisos de perfiles; los clientes
-- autenticados siguen sin poder escribir perfiles aunque existan políticas antiguas.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.profiles to service_role;
  end if;
end;
$$;

-- Solo la API del servidor, después de comprobar al administrador, puede
-- crear perfiles. El rol propio nunca puede cambiarse desde el navegador.
drop policy if exists office_profiles_visibility on public.profiles;
create policy office_profiles_visibility on public.profiles as restrictive for select to authenticated
using (id = auth.uid() or (select public.current_office_role()) in ('admin', 'supervisor'));
drop policy if exists office_profiles_insert on public.profiles;
create policy office_profiles_insert on public.profiles as restrictive for insert to authenticated with check (false);
drop policy if exists office_profiles_update on public.profiles;
create policy office_profiles_update on public.profiles as restrictive for update to authenticated using (false) with check (false);
drop policy if exists office_profiles_delete on public.profiles;
create policy office_profiles_delete on public.profiles as restrictive for delete to authenticated using (false);

do $$
declare target text;
begin
  foreach target in array array['agencies', 'document_types', 'lawyers', 'auxiliaries',
    'municipalities', 'case_files', 'documents', 'movements'] loop
    execute format('drop policy if exists office_operator_insert on public.%I', target);
    execute format('create policy office_operator_insert on public.%I as restrictive for insert to authenticated
      with check ((select public.current_office_role()) in (''admin'', ''supervisor'', ''empleado''))', target);
  end loop;
  foreach target in array array['agencies', 'document_types', 'lawyers', 'auxiliaries', 'municipalities'] loop
    execute format('drop policy if exists office_manager_delete on public.%I', target);
    execute format('create policy office_manager_delete on public.%I as restrictive for delete to authenticated
      using ((select public.current_office_role()) in (''admin'', ''supervisor''))', target);
  end loop;
end;
$$;

-- Todos los perfiles autorizados conservan la restauración. Archivar requiere
-- administrador/supervisor. Ningún cliente puede editar estado o etiqueta.
drop policy if exists office_document_archive on public.documents;
create policy office_document_archive on public.documents as restrictive for update to authenticated
using ((select public.current_office_role()) in ('admin', 'supervisor') or archived_at is not null)
with check ((select public.current_office_role()) in ('admin', 'supervisor') or archived_at is null);

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

  if public.current_office_role() is null then
    raise sqlstate 'PT403' using message = 'Tu cuenta no tiene un perfil autorizado.';
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

  if coalesce(public.current_office_role(), '') not in ('admin', 'supervisor', 'empleado') then
    raise sqlstate 'PT403' using message = 'Tu cuenta no tiene permiso para registrar movimientos.';
  end if;
  if (p_is_correction or p_change_label)
    and coalesce(public.current_office_role(), '') not in ('admin', 'supervisor') then
    raise sqlstate 'PT403' using message = 'Solo administradores y supervisores pueden corregir documentos.';
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

notify pgrst, 'reload schema';
commit;
