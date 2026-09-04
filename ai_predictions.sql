-- ai_predictions.sql — reference-only. Already included in schema.sql.
-- Kept for symmetry with the la-liga reference repo.

create table if not exists public.ai_predictions (
  match_id      text primary key,
  home          text not null default '',
  away          text not null default '',
  date          text not null default '',
  pick          text,
  confidence    text,
  reason        text,
  status        text not null default 'pending',
  tx_hash       text,
  error         text,
  submitted_at  timestamptz,
  stored_at     timestamptz
);

alter table public.ai_predictions enable row level security;
drop policy if exists "ai_predictions public read" on public.ai_predictions;
create policy "ai_predictions public read" on public.ai_predictions for select using (true);
