-- Таблиця для зберігання сесії підключення банку (Enable Banking).
-- Доступ до неї мають тільки Edge Functions (service role), не публічний API.
-- Запускати в Supabase: SQL Editor → New query → вставити → Run.

create table if not exists public.bank_sessions (
  id text primary key default 'main',
  session_id text,
  accounts jsonb,
  updated_at timestamptz not null default now()
);
insert into public.bank_sessions (id) values ('main') on conflict (id) do nothing;

alter table public.bank_sessions enable row level security;
revoke all on public.bank_sessions from anon, authenticated;
