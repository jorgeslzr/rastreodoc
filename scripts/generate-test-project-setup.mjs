// Usage: node scripts/generate-test-project-setup.mjs > /tmp/rastreadoc-pruebas.sql
// For a NEW, EMPTY Supabase test project. Never imports office data or users.
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
if (/^\s*(?:begin|commit|rollback);\s*$/im.test(schema)) {
  throw new Error("The schema contains transaction boundaries; review the test setup generator.");
}

process.stdout.write(`-- RASTREADOC: inicialización EXCLUSIVA de un proyecto de pruebas NUEVO Y VACÍO.
-- Comprobar el nombre/dirección del proyecto en SQL Editor antes de ejecutar.
-- No ejecutar en la base de la oficina ni en otro sistema existente.
-- Crea solo datos ficticios. No crea usuarios ni contiene contraseñas o claves.

begin;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public')
    or exists (select 1 from auth.users) then
    raise exception 'Proyecto no vacío. Se canceló la preparación sin modificar datos. Usa un proyecto de pruebas nuevo.';
  end if;
end;
$$;

${schema}

-- Catálogos y documentos ficticios para comprobar captura y movimientos.
insert into public.agencies (id, name) values
  ('00000000-0000-4000-8000-000000000010', 'REGISTRO PÚBLICO'),
  ('00000000-0000-4000-8000-000000000011', 'TESORERÍA MUNICIPAL');
insert into public.document_types (id, name) values
  ('00000000-0000-4000-8000-000000000020', 'CERTIFICADO'),
  ('00000000-0000-4000-8000-000000000021', 'ISAI');
insert into public.case_files (id, number) values
  ('00000000-0000-4000-8000-000000000030', 'PRUEBA-001');
insert into public.lawyers (id, name) values
  ('00000000-0000-4000-8000-000000000040', 'ABOGADO DE PRUEBA');
insert into public.auxiliaries (id, name) values
  ('00000000-0000-4000-8000-000000000050', 'AUXILIAR DE PRUEBA');
insert into public.municipalities (name) values ('MUNICIPIO DE PRUEBA');
insert into public.documents (
  id, case_file_id, document_type_id, agency_id, lawyer_id, auxiliary_id, label, qr_token
) values
  ('00000000-0000-4000-8000-000000000060',
   '00000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-000000000020',
   '00000000-0000-4000-8000-000000000010',
   '00000000-0000-4000-8000-000000000040',
   '00000000-0000-4000-8000-000000000050',
   'DOCUMENTO FICTICIO 1', '11111111-1111-4111-8111-111111111111'),
  ('00000000-0000-4000-8000-000000000061',
   '00000000-0000-4000-8000-000000000030',
   '00000000-0000-4000-8000-000000000021',
   '00000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-000000000040',
   '00000000-0000-4000-8000-000000000050',
   'DOCUMENTO FICTICIO 2', '22222222-2222-4222-8222-222222222222');

commit;

notify pgrst, 'reload schema';

select 'Preparación de pruebas completada' as resultado,
  (select count(*) from public.case_files) as expedientes,
  (select count(*) from public.documents) as documentos,
  (select count(*) from public.movements) as movimientos;
`);
