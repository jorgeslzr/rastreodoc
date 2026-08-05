-- Agrega un identificador opcional para distinguir documentos repetidos dentro del mismo expediente.
alter table public.documents
  add column if not exists label text;

alter table public.documents
  drop constraint if exists document_label_length;

alter table public.documents
  add constraint document_label_length check (
    label is null or length(label) <= 120
  );
