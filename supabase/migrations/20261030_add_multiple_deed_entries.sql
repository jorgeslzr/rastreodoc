alter table public.documents
  add column if not exists deed_entries jsonb not null default '[]'::jsonb;

-- Preserve the deed information that was captured before multiple groups were
-- supported by placing the original three columns into the first group.
update public.documents
set deed_entries = jsonb_build_array(jsonb_build_object(
  'folio_forma', coalesce(folio_forma, ''),
  'municipality', coalesce(municipality, ''),
  'cadastral_file_number', coalesce(cadastral_file_number, '')
))
where deed_entries = '[]'::jsonb
  and (folio_forma is not null or municipality is not null or cadastral_file_number is not null);

alter table public.documents drop constraint if exists documents_deed_entries_array;
alter table public.documents add constraint documents_deed_entries_array
  check (jsonb_typeof(deed_entries) = 'array');

notify pgrst, 'reload schema';
