-- Agrega el número de boleta a cada movimiento de envío o reingreso.
alter table public.movements
  add column if not exists receipt_number text;

alter table public.movements
  drop constraint if exists receipt_number_length;

alter table public.movements
  add constraint receipt_number_length check (
    receipt_number is null or length(receipt_number) <= 100
  );
