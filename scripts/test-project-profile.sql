-- SOLO en SQL Editor del proyecto de PRUEBAS que acabamos de preparar.
-- No lleva contraseñas ni cambia usuarios o perfiles existentes.
do $$
declare
  test_user uuid;
begin
  if not exists (
    select 1 from public.case_files
    where id = '00000000-0000-4000-8000-000000000030' and number = 'PRUEBA-001'
  ) or (select count(*) from public.documents
    where case_file_id = '00000000-0000-4000-8000-000000000030'
      and ((id = '00000000-0000-4000-8000-000000000060'
            and qr_token = '11111111-1111-4111-8111-111111111111')
        or (id = '00000000-0000-4000-8000-000000000061'
            and qr_token = '22222222-2222-4222-8222-222222222222'))
  ) <> 2 then
    raise exception 'Este no es el proyecto de pruebas preparado. Se canceló sin cambiar perfiles.';
  end if;

  select id into test_user from auth.users
  where lower(email) = 'pruebas@usuarios.rastreadoc.mx'
    and email_confirmed_at is not null;
  if test_user is null then
    raise exception 'Crea y confirma primero el usuario pruebas@usuarios.rastreadoc.mx en Authentication.';
  end if;

  if exists (select 1 from public.profiles where id = test_user
    and (username::text is distinct from 'pruebas' or role is distinct from 'admin'))
    or exists (select 1 from public.profiles where username = 'pruebas' and id <> test_user) then
    raise exception 'Ya existe un perfil diferente. Se canceló sin modificarlo.';
  end if;

  insert into public.profiles (id, username, role)
  values (test_user, 'pruebas', 'admin')
  on conflict (id) do nothing;
end;
$$;

select p.username as usuario, p.role as perfil
from public.profiles p join auth.users u on u.id = p.id
where lower(u.email) = 'pruebas@usuarios.rastreadoc.mx';
