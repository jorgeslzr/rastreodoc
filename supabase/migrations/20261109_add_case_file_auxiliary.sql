alter table public.case_files
  add column if not exists auxiliary text;

alter table public.case_files drop constraint if exists case_files_auxiliary_length;
alter table public.case_files add constraint case_files_auxiliary_length
  check (auxiliary is null or length(trim(auxiliary)) between 1 and 120);

notify pgrst, 'reload schema';
