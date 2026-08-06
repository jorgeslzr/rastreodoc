-- Elimina los expedientes de prueba existentes y todos sus datos operativos relacionados.
-- Los catálogos de tipos de documento y dependencias se conservan.
begin;

delete from public.movements;
delete from public.documents;
delete from public.case_files;

commit;
