-- Repair environments where the catalog migration was applied before the deed
-- fields migration. Every statement is idempotent and safe to run again.
alter table public.documents
  add column if not exists folio_forma text,
  add column if not exists municipality text,
  add column if not exists cadastral_file_number text;

alter table public.documents drop constraint if exists documents_deed_fields_length;
alter table public.documents add constraint documents_deed_fields_length check (
  (folio_forma is null or length(folio_forma) <= 120)
  and (municipality is null or length(municipality) <= 120)
  and (cadastral_file_number is null or length(cadastral_file_number) <= 120)
);

-- Ask PostgREST to make the repaired columns available immediately.
notify pgrst, 'reload schema';
