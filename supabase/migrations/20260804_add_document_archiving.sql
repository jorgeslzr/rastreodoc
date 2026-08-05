-- Permite ocultar documentos capturados por error sin borrar su historial.
alter table public.documents
  add column if not exists archived_at timestamptz;

grant update on public.documents to authenticated;
