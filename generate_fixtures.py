"""
Generate fixtures.json for the 2026/27 UEFA Champions League league phase
(matchdays 1-8, 144 fixtures across 36 clubs).

Pulls live data from football-data.org so the team names, kickoff times, and
fixture IDs are always accurate. Uses the FOOTBALL_DATA_API_KEY env var.

UEFA Champions League's football-data.org competition code is "CL".

The new (2024-onwards) league phase has 36 teams. Every club plays 8 games
(4 home / 4 away). The API returns matches with `stage` set to LEAGUE_STAGE
(the new UCL format). Anything outside that stage (qualifying rounds,
play-offs, knockouts) is excluded from v1 — knockouts will use the same
per-leg contract in a later phase.

Run:
    python generate_fixtures.py          # writes fixtures.json
    python generate_fixtures.py --dry    # prints without writing
    python generate_fixtures.py --matchday 1
"""

import json
import sys
import os
import urllib.request

API_KEY = os.environ.get("FOOTBALL_DATA_API_KEY", "")
if not API_KEY:
    sys.exit("FOOTBALL_DATA_API_KEY not set")

# 1..8 inclusive — the 2026/27 UCL league phase.
MATCHDAYS = range(1, 9)

# Pin the season we're deploying markets for. The football-data.org API's
# `currentSeason` for competition CL points to 2026/27 through mid-2027, so
# for now this matches the endpoint's implicit default. Pinning it explicitly
# is defensive: once the season ends the API will roll forward to 2027/28, and
# without ?season=2026 any late re-run would fetch the WRONG season and mint
# wildly-mis-dated markets.
SEASON = 2026

# Plausible calendar window for the 2026/27 UCL season. Any kickoff outside
# this range is a strong signal something is wrong (API returned a different
# season, timezone bug, etc.) and the script refuses to write fixtures.json.
import datetime as _dt
_SEASON_MIN_TS = int(_dt.datetime(2026, 8, 1,  tzinfo=_dt.timezone.utc).timestamp())
_SEASON_MAX_TS = int(_dt.datetime(2027, 6, 30, tzinfo=_dt.timezone.utc).timestamp())

# Only accept league-phase fixtures. The football-data.org API labels the new
# UCL group step as LEAGUE_STAGE (the classic GROUP_STAGE label was replaced
# when UEFA switched formats in 2024). Both are accepted defensively.
_LEAGUE_PHASE_STAGES = {"LEAGUE_STAGE", "GROUP_STAGE", "LEAGUE"}

# football-data.org shortName -> name BBC Sport uses for UCL clubs. BBC
# generally prints the short popular / anglicised name; only the clubs whose
# BBC label differs from football-data's shortName strictly need remapping.
# Extra variants (accented forms, alternate spellings, common English
# shorthands seen on BBC / ESPN score pages) are included so a source-side
# rename never silently degrades team-name normalisation.
BBC_NAME = {
    # England
    "Manchester City":       "Manchester City",
    "Man City":              "Manchester City",
    "Manchester United":     "Manchester United",
    "Man United":            "Manchester United",
    "Man Utd":               "Manchester United",
    "Liverpool":             "Liverpool",
    "Arsenal":               "Arsenal",
    "Aston Villa":           "Aston Villa",

    # Spain
    "Real Madrid":           "Real Madrid",
    "Barcelona":             "Barcelona",
    "FC Barcelona":          "Barcelona",
    "Barça":                 "Barcelona",
    "Barca":                 "Barcelona",
    "Atletico Madrid":       "Atletico Madrid",
    "Atlético Madrid":       "Atletico Madrid",
    "Atlético de Madrid":    "Atletico Madrid",
    "Atleti":                "Atletico Madrid",
    "Atletico":              "Atletico Madrid",
    "Villarreal":            "Villarreal",
    "Villarreal CF":         "Villarreal",
    "Real Betis":            "Real Betis",
    "Betis":                 "Real Betis",

    # Germany
    "Bayern":                "Bayern Munich",
    "Bayern Munich":         "Bayern Munich",
    "Bayern München":        "Bayern Munich",
    "FC Bayern München":     "Bayern Munich",
    "FC Bayern":             "Bayern Munich",
    "Borussia Dortmund":     "Borussia Dortmund",
    "Dortmund":              "Borussia Dortmund",
    "BVB":                   "Borussia Dortmund",
    "RB Leipzig":            "RB Leipzig",
    "Leipzig":               "RB Leipzig",
    "Stuttgart":             "Stuttgart",
    "VfB Stuttgart":         "Stuttgart",

    # Italy
    "Inter":                 "Inter Milan",
    "Inter Milan":           "Inter Milan",
    "Internazionale":        "Inter Milan",
    "FC Internazionale Milano": "Inter Milan",
    "Napoli":                "Napoli",
    "SSC Napoli":            "Napoli",
    "Roma":                  "Roma",
    "AS Roma":               "Roma",
    "Como":                  "Como",
    "Como 1907":             "Como",

    # France
    "Paris Saint-Germain":   "Paris Saint-Germain",
    "Paris St-Germain":      "Paris Saint-Germain",
    "Paris St Germain":      "Paris Saint-Germain",
    "PSG":                   "Paris Saint-Germain",
    "Lille":                 "Lille",
    "LOSC Lille":            "Lille",
    "LOSC":                  "Lille",
    "Lens":                  "Lens",
    "RC Lens":               "Lens",

    # Portugal
    "Porto":                 "Porto",
    "FC Porto":              "Porto",
    "Sporting CP":           "Sporting CP",
    "Sporting Lisbon":       "Sporting CP",
    "Sporting Clube de Portugal": "Sporting CP",

    # Netherlands
    "PSV":                   "PSV Eindhoven",
    "PSV Eindhoven":         "PSV Eindhoven",
    "Feyenoord":             "Feyenoord",

    # Belgium
    "Club Brugge":           "Club Brugge",
    "Club Bruges":           "Club Brugge",
    "Club Brugge KV":        "Club Brugge",

    # Turkey
    "Galatasaray":           "Galatasaray",
    "Galatasaray SK":        "Galatasaray",
    "Fenerbahce":            "Fenerbahce",
    "Fenerbahçe":            "Fenerbahce",
    "Fenerbahçe SK":         "Fenerbahce",

    # Greece
    "AEK Athens":            "AEK Athens",
    "AEK":                   "AEK Athens",
    "AEK Athens FC":         "AEK Athens",
    "PAE AEK":               "AEK Athens",

    # Austria
    "LASK":                  "LASK",
    "LASK Linz":             "LASK",

    # Norway
    "Bodo/Glimt":            "Bodo/Glimt",
    "Bodø/Glimt":            "Bodo/Glimt",
    "Bodø / Glimt":          "Bodo/Glimt",
    "FK Bodo/Glimt":         "Bodo/Glimt",
    "FK Bodø/Glimt":         "Bodo/Glimt",
    "Viking":                "Viking",
    "Viking FK":             "Viking",

    # Czechia
    "Slavia Prague":         "Slavia Prague",
    "Slavia Praha":          "Slavia Prague",
    "SK Slavia Praha":       "Slavia Prague",

    # Slovakia
    "Slovan Bratislava":     "Slovan Bratislava",
    "Sl. Bratislava":        "Slovan Bratislava",
    "ŠK Slovan Bratislava":  "Slovan Bratislava",

    # Ukraine
    "Shakhtar Donetsk":      "Shakhtar Donetsk",
    "Shakhtar":              "Shakhtar Donetsk",
    "Shaktar":               "Shakhtar Donetsk",
    "FC Shakhtar Donetsk":   "Shakhtar Donetsk",
    "FK Shakhtar Donetsk":   "Shakhtar Donetsk",

    # Azerbaijan
    "Sabah":                 "Sabah",
    "Sabah FK":              "Sabah",
    "Sabah FC":              "Sabah",
}


def bbc_name(short: str) -> str:
    return BBC_NAME.get(short, short)


def fetch_all_matches() -> list:
    """
    Pull the full 2026/27 CL match set in one call. We filter to the league
    phase (and optionally a single matchday) client-side — the API's
    `?matchday=N` filter can be finicky when the season straddles years.
    """
    url = (
        "https://api.football-data.org/v4/competitions/CL/matches"
        f"?season={SEASON}"
    )
    req = urllib.request.Request(url, headers={"X-Auth-Token": API_KEY})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())["matches"]


def main():
    dry = "--dry" in sys.argv
    only_md = None
    if "--matchday" in sys.argv:
        try:
            only_md = int(sys.argv[sys.argv.index("--matchday") + 1])
        except (ValueError, IndexError):
            sys.exit("--matchday requires an integer")

    print(f"Fetching UCL {SEASON}/{SEASON+1} matches from football-data.org…",
          end=" ", flush=True)
    matches_raw = fetch_all_matches()
    print(f"{len(matches_raw)} rows")

    # Filter to league-phase fixtures.
    league_matches = [m for m in matches_raw if m.get("stage") in _LEAGUE_PHASE_STAGES]
    print(f"  league-phase rows: {len(league_matches)}")

    fixtures = []
    seq_per_md: dict[int, int] = {}
    unmapped: set[str] = set()

    # Deterministic ordering: (matchday, kickoff, external id) so match_ids
    # are stable across re-runs.
    for m in sorted(
        league_matches,
        key=lambda x: (x.get("matchday") or 0, x.get("utcDate") or "", x.get("id") or 0),
    ):
        md = m.get("matchday")
        if md is None:
            continue
        if md not in MATCHDAYS:
            continue
        if only_md is not None and md != only_md:
            continue

        seq_per_md[md] = seq_per_md.get(md, 0) + 1
        match_id = f"ucl2027_md{md}_{seq_per_md[md]:02d}"
        kickoff_ts = int(
            _dt.datetime.fromisoformat(
                m["utcDate"].replace("Z", "+00:00")
            ).timestamp()
        )

        home_short = m["homeTeam"]["shortName"] or m["homeTeam"]["name"]
        away_short = m["awayTeam"]["shortName"] or m["awayTeam"]["name"]

        home_bbc = bbc_name(home_short)
        away_bbc = bbc_name(away_short)
        # Track any club we did not explicitly map — the fallback returns the
        # raw shortName which may not match BBC exactly.
        if home_short not in BBC_NAME:
            unmapped.add(home_short)
        if away_short not in BBC_NAME:
            unmapped.add(away_short)

        game_date = _dt.datetime.utcfromtimestamp(kickoff_ts).date().isoformat()

        fixtures.append({
            "match_id":          match_id,
            "external_match_id": m["id"],
            "home":              home_bbc,
            "away":              away_bbc,
            "home_full":         m["homeTeam"]["name"],
            "away_full":         m["awayTeam"]["name"],
            "kickoff_ts":        kickoff_ts,
            "game_date":         game_date,
            "matchday":          md,
            "stage":             "league_phase",
        })

    # ---------------- Sanity checks (fail hard rather than write bad data) ----
    # Full league phase = 8 matchdays * 18 matches = 144. When --matchday is
    # used we expect just that matchday (18 fixtures).
    if only_md is not None:
        expected = 18
        actual = len(fixtures)
        if actual == 0:
            sys.exit(f"REFUSING TO WRITE: 0 fixtures for matchday {only_md}. "
                     "Check the API's stage / matchday labels.")
    else:
        expected = 18 * len(list(MATCHDAYS))
    if len(fixtures) != expected:
        print(f"WARN: expected {expected}, got {len(fixtures)}. Continuing — the API "
              "may not have published every matchday yet.")

    ids = {f["match_id"] for f in fixtures}
    if len(ids) != len(fixtures):
        sys.exit("duplicate match_id in generated fixtures")
    ext_ids = {f["external_match_id"] for f in fixtures}
    if len(ext_ids) != len(fixtures):
        sys.exit("duplicate external_match_id in generated fixtures")

    # Season-window check: every kickoff MUST fall inside the 2026/27 window.
    bad = [
        (f["match_id"], f["kickoff_ts"])
        for f in fixtures
        if not (_SEASON_MIN_TS <= f["kickoff_ts"] <= _SEASON_MAX_TS)
    ]
    if bad:
        sys.exit(
            f"REFUSING TO WRITE: {len(bad)} kickoff(s) outside 2026/27 window "
            f"({_dt.datetime.utcfromtimestamp(_SEASON_MIN_TS).date()} .. "
            f"{_dt.datetime.utcfromtimestamp(_SEASON_MAX_TS).date()}). "
            f"First offender: {bad[0]}"
        )

    for f in fixtures:
        if not f["home"] or not f["away"]:
            sys.exit(f"empty team name on {f['match_id']}: {f}")

    fixtures.sort(key=lambda f: (f["matchday"], f["kickoff_ts"]))

    if unmapped:
        print("\nWARN: shortNames NOT in BBC_NAME map (using raw API name — please add):")
        for name in sorted(unmapped):
            print(f"  - {name!r}")

    if dry:
        print(json.dumps(fixtures, indent=2))
    else:
        with open("fixtures.json", "w", encoding="utf-8") as fh:
            json.dump(fixtures, fh, indent=2)
        print(f"\nOK fixtures.json written — {len(fixtures)} matches")
        if fixtures:
            first_ts = fixtures[0]["kickoff_ts"]
            last_ts  = fixtures[-1]["kickoff_ts"]
            print(f"  First kickoff: {_dt.datetime.fromtimestamp(first_ts, tz=_dt.timezone.utc).isoformat()}")
            print(f"  Last  kickoff: {_dt.datetime.fromtimestamp(last_ts,  tz=_dt.timezone.utc).isoformat()}")
        # Per-matchday summary.
        by_md: dict[int, int] = {}
        for f in fixtures:
            by_md[f["matchday"]] = by_md.get(f["matchday"], 0) + 1
        for md in sorted(by_md):
            print(f"  MD{md}: {by_md[md]} fixtures")


if __name__ == "__main__":
    main()
