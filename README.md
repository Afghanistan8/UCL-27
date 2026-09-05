# UCL '27 Predict

**Fully on-chain, pari-mutuel prediction markets for the 2026/27 UEFA Champions League — settled by AI consensus on [GenLayer](https://genlayer.com) Bradbury testnet, with no oracle, no backend resolver, and no admin keys touching the money.**

Not affiliated with UEFA. Team names and fixture data are used for identification only.

---

## What it does

- Anyone with test GEN can stake on any deployed UCL fixture — **home win, draw, or away win** — with a 2 GEN minimum.
- Every match is its own **Intelligent Contract** holding three pools (home / draw / away). Your stake goes into the pool for your pick.
- After kickoff the contract **reads the full-time score straight off the web** and resolves itself through validator consensus. Winners split the entire pot pro-rata. No rake, no house edge.
- Separately, GenLayer's validators publish their **own pre-match prediction** ("the AI Call") for each fixture, stored on-chain, shown next to the crowd's pools so you can see where the machine and the market disagree.
- A live **UEFA Champions League league-phase table** and a **leaderboard** of the sharpest predictors round it out.

Everything the money touches lives on-chain. Supabase is only a fast read-mirror so the UI loads instantly — it is never the source of truth.

The core belief behind the project: **a prediction market shouldn't need a trusted oracle.** GenLayer lets the contract itself read the web and reach consensus on what happened. That's the whole thing.

---

## The 2026/27 UCL league phase

- 36 teams, 8 matchdays, 144 total league-phase fixtures.
- Each club plays 8 games (4 home / 4 away).
- Top 8 advance directly to the Round of 16. Places 9–24 play a knockout play-off. Places 25–36 are out.
- Calendar:
  - MD1: 8–10 Sep 2026 · MD2: 13–14 Oct · MD3: 20–21 Oct · MD4: 3–4 Nov
  - MD5: 24–25 Nov · MD6: 8–9 Dec · MD7: 19–20 Jan 2027 · MD8: 27 Jan 2027
  - Playoffs 16–17 & 23–24 Feb · R16 9–10 & 16–17 Mar · QF 6–7 & 13–14 Apr
  - SF 27–28 Apr & 4–5 May · Final 5 Jun 2027, Estadio Metropolitano

**v1 ships the 144 league-phase markets as 1X2 (home / draw / away after 90 minutes plus stoppage — league-phase matches have no extra time and no penalty shootout).** Knockouts will use the same per-leg contract in a later phase.

---

## How it works under the hood

### 1. The contract reads the web itself — from two independent sources

In `prediction_market.py`, resolution renders the live scoreboard *inside* the contract execution, from **two independent sources**: BBC Sport (primary) and ESPN (secondary), each addressed by the fixture's date so the same code handles any calendar day of the season.

```python
primary   = gl.nondet.web.render(self.resolution_url,   mode="text")  # BBC by date
secondary = gl.nondet.web.render(self.resolution_url_2, mode="text")  # ESPN by date
```

There is no oracle service, no off-chain job pushing scores in, no trusted signer. The web pages **are** the source of truth, fetched by the validators at the moment of resolution. **Both sources must render and agree** before a market can settle — a single source, however confident, never moves money (see [Resolution hardening](#resolution-hardening)). Team names are normalized in the prompt (`"Man City"/"Manchester City"`, `"Bayern München"/"FC Bayern" = "Bayern Munich"`, `"Inter"/"Internazionale" = "Inter Milan"`, `"Paris St-Germain"/"PSG" = "Paris Saint-Germain"`, `"Bodø/Glimt" = "Bodo/Glimt"`, `"Slavia Praha" = "Slavia Prague"`, and more) so spelling differences between sources still match the same fixture.

### 2. AI consensus turns a messy web page into a settled result

The score is extracted by an LLM, and the result only finalizes if the validators independently agree on the same structured answer:

```python
result_json = gl.eq_principle.strict_eq(get_match_result)
```

A final score is an objective fact, so resolution uses **strict equivalence** — every validator must arrive at the identical `{score, winner}` JSON or nothing is written. If the match hasn't finished, `winner` comes back `-1` and the contract simply stays open to retry later.

### 3. The AI Call — validators forecasting, not just reporting

`ai_predictor.py` is a separate, single contract for the whole season. Before a match it asks the network for a *prediction*, using the **non-comparative** equivalence principle:

```python
raw = gl.eq_principle.prompt_non_comparative(
    gather_evidence,           # returns the input the LLM reasons over
    task="...",                # "predict this fixture's outcome"
    criteria="...",            # "is this a defensible home/draw/away call?"
)
```

The leader validator produces a pick + confidence + one-line reason; the other validators judge whether that answer is defensible against fixed criteria, rather than each re-running the whole forecast. This is deliberately lighter on Bradbury's small validator set than forcing every validator to independently re-predict, and "is this call reasonable?" is the right question to reach consensus on for a subjective judgement. The pick is parsed and normalized deterministically after consensus so a stray capital letter or code fence can't revert a good prediction.

> **The two equivalence principles:** resolution uses `strict_eq` (there is one correct score); the AI Call uses `prompt_non_comparative` (a prediction is a judgement).

### What this replaces

| Traditional approach | This project |
|---|---|
| Chainlink or a paid feed for sports scores | Free, read directly from the web (BBC + ESPN) |
| A backend service pushing results on-chain | No backend — the contract resolves itself |
| An admin clicking "resolve" | Fully autonomous, driven by cron |
| A single trusted oracle | Multiple validators reaching consensus |

---

## Betting integrity & security

Three design constraints keep the market honest, all enforced **on-chain** with no privileged key:

**Fixture-specific betting deadline (irreversible close).** The constructor takes `kickoff_ts` (Unix epoch seconds, immutable). `submit_prediction()` reverts at or after it — checked against the consensus transaction time (`gl.message_raw["datetime"]`), so no stake can be placed once the match kicks off, and therefore never once the result is known.

<a id="resolution-hardening"></a>
**Resolution hardening (v0.3.2).** The LLM is treated as an untrusted *extractor*, not as the gate. It proposes a `{score, winner}`; deterministic contract code then decides whether that proposal may move payout state. Every check below runs in ordinary Python after `strict_eq`, and every one of them **fails closed** — on any failure `result`, `final_score`, `status` and the pools are left untouched and the cron simply retries:

- **`resolve()` cannot run before kickoff.** It reverts with `too early: match has not kicked off`, checked against the same consensus clock as `submit_prediction()`. The gate runs *before* the attempt counter and *before* any web render, so a premature call cannot even reach the model.
- **Settlement requires BBC *and* ESPN — both present, and in agreement.** `secondary_present` is computed from the actual render and travels through `strict_eq`, so validators cannot disagree about whether ESPN was read. A blank or failed secondary can never settle a market, no matter what the model claims. There is deliberately **no primary-only path in `resolve()`**.
- **Winner allowlist.** Only the exact integers `-1`, `0`, `1`, `2` are accepted. `3`, `"1"`, `1.0`, `true` and `null` all revert with `invalid winner`. Booleans are rejected explicitly, since `bool` subclasses `int` and `True == 1`.
- **The score must parse and match the winner.** `"2:1"` and `"2-1"` parse; `""`, `"-"`, `"FT"`, `"2"`, `"2:1:0"`, `"two:one"` and en-dash forms revert with `malformed score`. A score that contradicts its winner (`"2:1"` with `winner=2`) reverts with `inconsistent score and winner`. The stored `final_score` is normalised to `H:A`.
- **No `else` fallthrough.** `winner` maps explicitly: `1 → home`, `2 → away`, `0 → draw`. Previously any value that was not negative fell through an `else` and settled as a **draw**.

Covered by `tests/test_resolve_hardening.py` (29 tests): premature resolution, missing secondary, source conflict, invalid winner, malformed score, inconsistent score, plus happy-path settlement.

> `mark_postponed()` keeps its narrower primary-only fallback, and that asymmetry is intentional: it can only ever open **1:1 refunds**, whereas `resolve()` pays winners. One source is enough to give everyone their own money back; it is not enough to decide who wins.

**Postponements are verified, not asserted.** `mark_postponed()` is permissionless (like `resolve()`), callable only while a market is `open` and only after kickoff + a 3-hour grace window. It re-renders BBC + ESPN and classifies **each source independently** — `postponed` / `finished` / `unknown` (or `unavailable`) — under `strict_eq`, then enforces the policy on-chain:

- A `finished` result on **either** source reverts (this also rejects a conflict where one source says postponed and the other shows a score) — a decided match can never be turned into a refund.
- The primary (authoritative) source must itself say postponed, and the secondary must agree.
- If the secondary is unavailable, it falls back to **primary-only, but only when the primary is explicit** (contains an explicit postponed / called-off / cancelled / suspended / abandoned wording).
- A suspended / abandoned fixture with no full-time score is treated as postponed; anything ambiguous or conflicting stays `open`.

Because there is no admin key that controls funds, the only reachable outcomes are a normal pari-mutuel settlement or a universal 1:1 refund. The full policy is covered by the tests in `tests/`.

---

## The wallet footgun (and how this repo dodges it)

Multiple browser wallets install multiple providers, and `window.ethereum` is not reliably the one the user chose. This project uses **EIP-6963** (`eip6963:announceProvider`) to discover every installed wallet and shows a chooser; the chosen provider is then passed as the top-level `provider` to `genlayer-js`'s `createClient`. `genlayer-js` builds its own transport and **ignores** a viem-style `transport` key — passing the chosen provider as `provider` is what makes signing come from the wallet the user actually picked.

Every write is gated by `ensureStudionet()`: read `eth_chainId`, and if it isn't Bradbury (`0x107d` / `4221`), `wallet_switchEthereumChain`, add on 4902 / -32603 / "Unrecognized chain", then re-read `eth_chainId` and throw if it still isn't Bradbury. See `frontend/lib/wallet.js`.

---

## Architecture

```
                 ┌────────────────────────────────────────────────┐
                 │  Frontend (ucl27-predict.vercel.app)             │
                 │  reads mirror ▼        writes via wallet ▼        │
                 └──────────┬──────────────────────┬────────────────┘
                            │                       │
                   Supabase (read-mirror)     GenLayer Bradbury
                            ▲                  ┌──────────────────┐
                            │                  │ per-match market  │
                            │                  │ contracts         │
        ┌───────────────────┴───────────┐      │ 1 AI predictor    │
        │  Cron (ucl27-predict-cron)     │─wr──▶└──────────────────┘
        │  /api/resolve-matches  ~10m    │             ▲
        │  /api/predict-matches  ~30m    │─────────────┘
        │  /api/standings         ~3h    │──▶ BBC Sport (UCL table)
        │  /api/live-scores       ~5m    │──▶ football-data.org (CL)
        └────────────────────────────────┘
```

**Trust flow:** the contracts are the source of truth. Cron writes to the contracts and mirrors public state into Supabase. The frontend reads Supabase for speed and reads the contracts directly for pools; it only ever writes through the user's own wallet, and even those mirror writes are re-verified against the chain server-side, so nobody can forge leaderboard rows.

---

## Repository layout

```
ucl27-predict/
├── prediction_market.py      # per-match Intelligent Contract (pari-mutuel + BBC/ESPN resolution)
├── ai_predictor.py           # single AI Call contract (pre-match predictions)
├── deploy.js                 # deploys market contracts (--matchday N, resumable, skips kicked-off fixtures)
├── deploy-ai.js              # deploys the AI predictor (one-time)
├── generate_fixtures.py      # pulls 2026/27 UCL fixtures from football-data.org (competition CL) → fixtures.json
├── fixtures.json             # fixtures with kickoff times + external IDs
├── deploy_checkpoint.json    # written by deploy.js; maps match_id → contract address
├── ai_predictor_address.txt  # written by deploy-ai.js; copy into .env as AI_PREDICTOR_ADDRESS
├── schema.sql                # complete Supabase schema + RLS (single paste)
├── standings.sql             # reference-only (already in schema.sql)
├── ai_predictions.sql        # reference-only (already in schema.sql)
├── .env.example
├── tests/
│   ├── test_deadline_and_postpone.py    # deadline + resolve + refund + mark_postponed
│   └── test_ai_predictor.py             # admin-only + idempotent + normalization
├── frontend/                 # canonical app — vanilla HTML/CSS/JS, no build step
│   ├── index.html
│   ├── app.js                # router, match list, match detail, My Picks, Leaderboard, Table
│   ├── style.css             # midnight-navy + starball-gold theme, light + dark
│   ├── favicon.svg
│   └── lib/                  # config, wallet (EIP-6963), contract (genlayer-js), supabase, crests
└── cron/
    ├── api/resolve-matches.js · predict-matches.js · standings.js · live-scores.js
    ├── api/mirror-prediction.js · set-username.js · mark-postponed.js   # chain-verified Supabase writes
    ├── vercel.json
    └── package.json
```

---

## The market contract (`prediction_market.py`)

One deployed instance per fixture. Immutable — team names, date and kickoff time are set in the constructor (`team1, team2, game_date, kickoff_ts`) and never change.

```python
submit_prediction(pick)   # payable; min 2 GEN; {home,draw,away}; one per wallet; reverts at/after kickoff
resolve()                 # permissionless; reverts before kickoff; settles ONLY on corroborated
                          # BBC+ESPN agreement with a validated winner and score
claim()                   # winning predictor pulls their pari-mutuel share (last claimer sweeps the rounding dust)
refund()                  # reclaim stake when a match goes to the refund path
mark_postponed()          # permissionless + source-verified; opens refunds only if the sources confirm postponement
```

**Payout math.** Pure pari-mutuel: `payout = stake * total_pool // winning_pool`. No fee, no rake. Integer division rounds each payout down — the **last winner to claim** sweeps the entire remaining contract balance, so no wei of dust is ever locked.

**Refund edge cases (Option X).** If nobody picked correctly (`winning_pool == 0`) OR everyone did (`winning_pool == total_pool`), the contract enters `refunding` and everyone gets their original stake back 1:1.

---

## Deploy

1. Copy `.env.example` → `.env` and fill in the values.
2. Install deploy deps: `npm install`
3. Generate fixtures: `python generate_fixtures.py` (needs `FOOTBALL_DATA_API_KEY`)
4. Deploy the AI predictor once: `node deploy-ai.js` → copy the printed address into `.env` as `AI_PREDICTOR_ADDRESS`.
5. Deploy a matchday of markets: `node deploy.js --matchday 1` (resumable via `deploy_checkpoint.json`; already-deployed matches are skipped).
6. Full season deploy: `node deploy.js` (144 markets — deploys pace themselves; safe to re-run).
7. Cron: deploy the `cron/` directory as its own Vercel project. Set the same env vars (plus `CRON_SECRET`).
8. Frontend: deploy the `frontend/` directory to Vercel. Fill in `frontend/lib/config.js` with your Supabase project's URL + publishable key and the cron project's URL.
9. Scheduling: add a `CRON_SECRET` repository secret on GitHub (see below).

> **Two Vercel projects, not one.** `cron/` and `frontend/` are deployed as
> separate projects from the same repo, differing only in **Root Directory**.
> The cron project holds every secret and exposes no UI — hitting its bare
> domain shows `/api/health`, a status page, not the app. The frontend project
> is fully static and takes **no** environment variables.

---

## Scheduling

The endpoints do the work; something has to decide *when*. That is
**[cron-job.org](https://cron-job.org)** — four jobs, each sending
`Authorization: Bearer <CRON_SECRET>`:

| Endpoint | Interval | Why |
|---|---|---|
| `/api/resolve-matches` | 10 min | Settlement — the money path. Always on, so a rescheduled fixture can't leave a market unsettled. No-ops when nothing is eligible. |
| `/api/predict-matches` | 30 min | Must land inside the endpoint's 30h pre-kickoff window. |
| `/api/standings` | 3 h | League-phase table scrape. |
| `/api/live-scores` | 5 min | Cosmetic only — never settles anything. Safe to pause outside match weeks. |

**Why not Vercel Cron:** the Hobby plan fires each entry only **once per day**,
far too slow to settle a market after full time. The four entries still in
`cron/vercel.json` are kept as a once-daily safety net; every endpoint is
idempotent, so overlapping schedulers are harmless — `resolve()` no-ops once a
market has settled, `predict()` reverts on a match that already has an AI call,
and `standings` is a plain delete-then-insert. On Vercel Pro, tighten those
entries to `*/10`, `*/30`, `0 */3` and `*/5` and drop cron-job.org.

> ⚠️ **`cron/vercel.json` is strictly schema-validated.** It accepts only known
> top-level keys (`$schema`, `rewrites`, `crons`, `functions`, …). JSON has no
> comment syntax, and adding a pseudo-comment key such as `_comment` makes
> Vercel reject the entire config with *"Vercel couldn't load a valid project
> configuration"* — the deployment fails and the previous build silently stays
> live. Document things here in the README instead.

**Why not GitHub Actions:** its `schedule:` trigger is best-effort — commonly
minutes late, and it skips ticks under load. More importantly GitHub disables
scheduled workflows after 60 days without a push, a real risk across the MD6
(Dec 2026) → MD7 (Jan 2027) winter gap. `.github/workflows/cron.yml` therefore
keeps only `workflow_dispatch`, as a **manual** runner.

### Manual runs

**Actions → cron → Run workflow**, then pick an endpoint (including
`mark-postponed` and `all`). Requires a `CRON_SECRET` repository secret:
**Settings → Secrets and variables → Actions → New repository secret**. The repo
is public, so the token must live in Secrets and never be committed. Optionally
set a `CRON_BASE_URL` repository *variable* if the cron project is renamed.

---

## Runtime dependency

The market and AI predictor contracts pin the GenLayer Python runtime:

```
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

If the official docs at `docs.genlayer.com` show a newer required hash, update the comment on the first line of both contracts to match — the runtime enforces this exactly.

---

## What it does NOT do

- No admin key over funds. Deployer is `admin` on the market contract but has no privileged method; `resolve()` and `mark_postponed()` are permissionless.
- No off-chain scoring. `resolve()` runs entirely inside the contract; cron only triggers it and mirrors the resulting state.
- No AMM, no order book, no multi-outcome markets. Fixed 1X2, pari-mutuel, one contract per match.
- Not affiliated with UEFA or the UEFA Champions League. Fixture data and club names are used for identification.

---

## License

MIT — see `LICENSE`.
