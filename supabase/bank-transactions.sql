-- Банківські транзакції, що чекають підтвердження категорії (банки),
-- плюс останній відомий баланс рахунку. Запускати після bank-sessions.sql.
-- Supabase: SQL Editor → New query → вставити → Run.

create table if not exists public.bank_pending (
  id bigint generated always as identity primary key,
  tx_id text unique not null,
  name text not null,
  amount numeric not null,
  tx_date date not null,
  status text not null default 'pending', -- 'pending' | 'confirmed' | 'dismissed'
  created_at timestamptz not null default now()
);

alter table public.bank_pending enable row level security;
revoke all on public.bank_pending from anon, authenticated;
grant select on public.bank_pending to anon, authenticated;
grant update (status) on public.bank_pending to anon, authenticated;
create policy bank_pending_read on public.bank_pending for select to anon, authenticated using (true);
create policy bank_pending_update_status on public.bank_pending for update to anon, authenticated using (true) with check (true);

-- Живий баланс картки: зберігаємо тут, а не в arkad.data, щоб серверний
-- запис з bank-sync ніколи не змагався з автозбереженням клієнта.
alter table public.bank_sessions add column if not exists balance numeric;
alter table public.bank_sessions add column if not exists balance_updated_at timestamptz;
grant select (balance, balance_updated_at) on public.bank_sessions to anon, authenticated;
create policy bank_sessions_read_balance on public.bank_sessions for select to anon, authenticated using (true);
