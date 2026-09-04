-- standings.sql — reference-only. Already included in schema.sql.
-- Kept for symmetry with the la-liga reference repo.

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

alter table public.standings enable row level security;
drop policy if exists "standings public read" on public.standings;
create policy "standings public read" on public.standings for select using (true);
