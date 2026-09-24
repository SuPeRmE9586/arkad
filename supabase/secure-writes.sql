-- Закриває запис у таблицю arkad для всіх, крім власника PIN.
-- Читати дані й далі може будь-хто, хто знає адресу бази.
-- Запускати в Supabase: SQL Editor → New query → вставити → Run.
-- ПЕРЕД запуском заміни ЗАМІНИ_НА_СВІЙ_PIN (рядок нижче) на свій пароль.
-- Сам пароль у репозиторій НЕ комітити.

create extension if not exists pgcrypto with schema extensions;

-- 0. Таблиця з даними застосунку (якщо її ще немає)
create table if not exists public.arkad (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.arkad (id, data) values ('main', '{}'::jsonb)
on conflict (id) do nothing;

-- 1. Секретна таблиця з хешем PIN. RLS увімкнено і політик немає → через API її не прочитати.
create table if not exists public.arkad_secret (
  id int primary key default 1 check (id = 1),
  pin_hash text not null
);
alter table public.arkad_secret enable row level security;
revoke all on public.arkad_secret from anon, authenticated;

insert into public.arkad_secret (id, pin_hash)
values (1, extensions.crypt('ЗАМІНИ_НА_СВІЙ_PIN', extensions.gen_salt('bf', 10)))
on conflict (id) do update set pin_hash = excluded.pin_hash;

-- 2. Таблиця arkad: прибираємо всі старі політики, лишаємо тільки читання.
alter table public.arkad enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'arkad' loop
    execute format('drop policy %I on public.arkad', p.policyname);
  end loop;
end $$;
grant select on public.arkad to anon, authenticated;
create policy arkad_read on public.arkad for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.arkad from anon, authenticated;

-- 3. Єдиний спосіб записати дані: функція, яка перевіряє PIN.
create or replace function public.arkad_save(p_data jsonb, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare h text;
begin
  select pin_hash into h from public.arkad_secret where id = 1;
  if h is null or p_pin is null or extensions.crypt(p_pin, h) <> h then
    return false;
  end if;
  update public.arkad set data = p_data, updated_at = now() where id = 'main';
  return found;
end $$;

revoke all on function public.arkad_save(jsonb, text) from public;
grant execute on function public.arkad_save(jsonb, text) to anon, authenticated;
