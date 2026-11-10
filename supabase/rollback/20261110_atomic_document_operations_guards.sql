-- Solo para una reversión coordinada si falla el despliegue del cliente nuevo.
-- Revisar REVISION_OPERATIVA.md. No ejecutar como parte de las migraciones.
-- Conserva las funciones, la tabla de confirmaciones y el historial existente.
begin;
drop trigger if exists movements_require_operation_rpc on public.movements;
drop trigger if exists documents_require_operation_rpc on public.documents;
commit;
