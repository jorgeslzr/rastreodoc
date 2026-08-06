-- Elimina los expedientes de prueba existentes y todos sus datos operativos relacionados.
-- Los catálogos de tipos de documento y dependencias se conservan.
begin;

-- TRUNCATE no ejecuta el trigger que protege los movimientos contra DELETE.
-- Las tres tablas se vacían juntas para respetar sus llaves foráneas.
truncate table
  public.movements,
  public.documents,
  public.case_files
restart identity;

commit;
