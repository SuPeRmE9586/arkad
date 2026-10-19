-- Фонова синхронізація з банком 4 рази на добу (максимум, дозволений
-- PSD2 без активної дії користувача — Delegated Regulation (EU) 2018/389,
-- ст. 36(5)(b)). Запускати в Supabase: SQL Editor → New query → Run.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'bank-sync-4x-daily',
  '0 */6 * * *', -- 00:00, 06:00, 12:00, 18:00 UTC
  $$
  select net.http_post(
    url := 'https://kvapzwtculjqnvycvrvi.supabase.co/functions/v1/bank-sync',
    headers := jsonb_build_object(
      'apikey', 'sb_publishable_k6hmu88rVk23x_RyfBhLkQ_OB33Mr8p',
      'Authorization', 'Bearer sb_publishable_k6hmu88rVk23x_RyfBhLkQ_OB33Mr8p',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Перевірити, що завдання створилось:
-- select * from cron.job;
-- Історія запусків:
-- select * from cron.job_run_details order by start_time desc limit 10;
