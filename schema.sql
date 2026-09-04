-- schema.sql — complete Supabase schema for UCL '27 Predict
-- Run this ONCE in the Supabase SQL editor for your NEW UCL '27 project
-- (do NOT reuse the La Liga project). It is the single source of truth: it
-- includes the standings and ai_predictions tables too, so you do NOT need
-- to run standings.sql / ai_predictions.sql separately (they're kept only
-- for reference).
--
-- The frontend uses the PUBLISHABLE key (RLS-restricted): it needs to SELECT
-- everything. All INSERT/UPDATE go through the secure mirror endpoints
-- (cron/api/*), which use the SECRET key (service role bypasses RLS) and
-- only write what the chain (or a wallet signature) already proves.
-- Trust lives on-chain; these tables are a fast mirror.

-- ============================================================ matches
create table if not exists public.matches (
  match_id          text primary key,
  contract_address  text,
  home              text not null default '',
  away              text not null default '',
  kickoff_ts        bigint,
  matchday          int,
  external_match_id bigint,
  stage             text default 'league_phase',
  status            text not null default 'scheduled',
  -- Lifecycle. IMPORTANT: 'refunding' is the ONLY claimable refund state,
  -- and it is copied from the CONTRACT (get_match_info) only after a
  -- verified mark_postponed(). 'postponed_pending' is an OFF-CHAIN hint
  -- written by live-scores (football-data POSTPONED/CANCELLED/SUSPENDED) —
  -- it is NOT claimable and must never be treated as 'refunding' by any
  -- client.
  --   scheduled | live | finished | resolved | refunding | postponed_pending
  result            text,                                -- home|draw|away
  final_score       text,
  live_score_home   int,
  live_score_away   int,
  live_minute       text,
  updated_at        timestamptz default now()
);
create index if not exists matches_kickoff_idx on public.matches (kickoff_ts);
create index if not exists matches_status_idx on public.matches (status);
create index if not exists matches_matchday_idx on public.matches (matchday);

-- ============================================================ pools (display mirror)
create table if not exists public.pools (
  match_id       text primary key references public.matches(match_id) on delete cascade,
  pool_home_wei  numeric(78,0) not null default 0,
  pool_draw_wei  numeric(78,0) not null default 0,
  pool_away_wei  numeric(78,0) not null default 0,
  total_wei      numeric(78,0) not null default 0,
  updated_at     timestamptz default now()
);

-- ============================================================ users
create table if not exists public.users (
  user_address  text primary key,
  username      text unique,
  created_at    timestamptz default now()
);

-- ============================================================ predictions (mirror)
create table if not exists public.predictions (
  id                bigint generated always as identity primary key,
  match_id          text not null,
  user_address      text not null,
  pick              text not null,               -- home|draw|away
  stake_wei         numeric(78,0) not null default 0,
  tx_hash           text,
  contract_address  text,
  claimed           boolean not null default false,
  refunded          boolean not null default false,
  claim_tx_hash     text,
  refund_tx_hash    text,
  submitted_at      timestamptz default now(),
  unique (match_id, user_address)
);
create index if not exists predictions_match_idx on public.predictions (match_id);
create index if not exists predictions_user_idx on public.predictions (user_address);

-- ============================================================ resolutions_log (cron)
create table if not exists public.resolutions_log (
  id                bigint generated always as identity primary key,
  match_id          text not null,
  contract_address  text,
  tx_hash           text,
  status            text not null default 'pending',  -- pending|completed|failed
  submitted_at      timestamptz default now(),
  completed_at      timestamptz,
  final_status      text,
  final_result      text,
  final_score       text,
  error             text
);
create index if not exists resolutions_status_idx on public.resolutions_log (status);

-- ============================================================ standings (UCL Table tab)
create table if not exists public.standings (
  team_id          bigint primary key,
  position         int,
  team             text,
  short_name       text,
  crest            text,
  played           int,
  won              int,
  draw             int,
  lost             int,
  goals_for        int,
  goals_against    int,
  goal_difference  int,
  points           int,
  form             text,
  updated_at       timestamptz default now()
);

-- ============================================================ ai_predictions (AI Call)
create table if not exists public.ai_predictions (
  match_id      text primary key,
  home          text not null default '',
  away          text not null default '',
  date          text not null default '',
  pick          text,
  confidence    text,
  reason        text,
  status        text not null default 'pending',  -- pending|stored|failed
  tx_hash       text,
  error         text,
  submitted_at  timestamptz,
  stored_at     timestamptz
);
create index if not exists ai_predictions_status_idx on public.ai_predictions (status);

-- ============================================================ RLS
alter table public.matches         enable row level security;
alter table public.pools           enable row level security;
alter table public.users           enable row level security;
alter table public.predictions     enable row level security;
alter table public.resolutions_log enable row level security;
alter table public.standings       enable row level security;
alter table public.ai_predictions  enable row level security;

-- Public read on everything the frontend renders.
do $$
declare t text;
begin
  foreach t in array array['matches','pools','users','predictions','standings','ai_predictions']
  loop
    execute format('drop policy if exists "%s public read" on public.%I', t, t);
    execute format('create policy "%s public read" on public.%I for select using (true)', t, t);
  end loop;
end $$;

-- WRITES ARE SERVICE-ROLE ONLY.
--
-- The publishable/anon key can SELECT but can NOT insert or update anything.
-- All writes go through the /api/mirror-prediction endpoint (chain-verified)
-- and /api/set-username (signature-verified). The service role bypasses RLS,
-- so no public write policy is needed — and none should exist.

drop policy if exists "predictions public insert" on public.predictions;
drop policy if exists "predictions public update" on public.predictions;
drop policy if exists "users public insert"       on public.users;

-- resolutions_log has no public policy => only the service key touches it.
