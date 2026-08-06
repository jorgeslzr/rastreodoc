-- Corrige el nombre capturado por error sin perder los documentos relacionados.
insert into public.agencies (name)
values ('REGISTRO PÚBLICO')
on conflict (name) do nothing;

update public.documents
set agency_id = (
  select id
  from public.agencies
  where name = 'REGISTRO PÚBLICO'
)
where agency_id in (
  select id
  from public.agencies
  where translate(upper(name::text), 'ÁÉÍÓÚÜÑ', 'AEIOUUN') in ('RESISTO PUBLICO', 'REGISTRO PUBLICO')
    and name::text <> 'REGISTRO PÚBLICO'
);

delete from public.agencies
where translate(upper(name::text), 'ÁÉÍÓÚÜÑ', 'AEIOUUN') in ('RESISTO PUBLICO', 'REGISTRO PUBLICO')
  and name::text <> 'REGISTRO PÚBLICO';
