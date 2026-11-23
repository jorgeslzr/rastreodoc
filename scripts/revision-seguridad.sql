-- Solo lectura. Ejecutar en SQL Editor y comprobar primero el proyecto elegido.
-- No muestra expedientes, contraseñas, claves ni tokens.
begin read only;

select
  (select count(*) from auth.users) as cuentas_auth,
  (select count(*) from public.profiles) as perfiles_oficina,
  (select count(*) from auth.users u left join public.profiles p on p.id = u.id where p.id is null) as cuentas_sin_perfil,
  (select count(*) from public.profiles where role in ('admin', 'supervisor')) as administradores_y_supervisores;

select c.relname as tabla, c.relrowsecurity as rls_activo,
  exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname
    and p.policyname='office_members_only' and p.permissive='RESTRICTIVE') as exige_perfil_oficina,
  exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=c.relname
    and p.policyname='office_no_anonymous' and p.permissive='RESTRICTIVE') as bloquea_anonimos
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('profiles','agencies','document_types','lawyers',
  'auxiliaries','municipalities','case_files','documents','movements')
order by c.relname;

select p.proname as funcion, pg_get_function_identity_arguments(p.oid) as argumentos,
  p.prosecdef as ejecuta_con_permisos_del_servidor,
  position('current_office_role' in pg_get_functiondef(p.oid)) > 0 as comprueba_perfil_oficina
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('save_document_operation', 'restore_archived_document')
order by p.proname;

select table_name, privilege_type, grantee
from information_schema.role_table_grants
where table_schema='public' and grantee in ('anon', 'authenticated', 'PUBLIC')
  and table_name in ('profiles','agencies','document_types','lawyers','auxiliaries',
    'municipalities','case_files','documents','movements')
order by table_name, grantee, privilege_type;

-- Funciones adicionales que deben incluirse en la revisión de un proyecto
-- con cambios propios. Solo nombres y permisos, sin código ni datos privados.
select p.proname as funcion_del_servidor,
  has_function_privilege('anon', p.oid, 'EXECUTE') as ejecutable_por_anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as ejecutable_con_sesion
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.prosecdef
order by p.proname;

commit;
