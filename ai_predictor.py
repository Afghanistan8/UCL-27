# v0.1.0
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing


# Valid predicted outcomes (same vocabulary as the pari-mutuel market)
PICK_HOME = "home"
PICK_DRAW = "draw"
PICK_AWAY = "away"
_VALID_PICKS = (PICK_HOME, PICK_DRAW, PICK_AWAY)


def _parse_prediction(raw: str, home: str, away: str) -> dict:
    """
    Deterministically turn the leader's LLM output into a clean prediction.

    Runs in ordinary (deterministic) contract code AFTER consensus, so every
    validator that adopted the leader's string derives the same result. The
    job here is to never let a formatting nit (a capital letter, a code fence,
    the model writing "home win" or the team name) revert an otherwise-good
    prediction — we normalize hard and only give up as a last resort.

    Returns {"pick", "confidence", "reason"} with pick guaranteed to be one of
    home/draw/away, or raises gl.vm.UserError if no outcome can be recovered.
    """
    text = raw.strip().replace("```json", "").replace("```", "").strip()

    pick_raw = ""
    confidence = "medium"
    reason = ""

    # Preferred path: the model returned the JSON object we asked for.
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            pick_raw = str(obj.get("pick", ""))
            confidence = str(obj.get("confidence", "medium")).strip().lower()
            reason = str(obj.get("reason", "")).strip()
    except Exception:
        # Fall through to scanning the raw text below.
        pick_raw = text

    pick = _normalize_pick(pick_raw, home, away, text)
    if pick not in _VALID_PICKS:
        raise gl.vm.UserError("could not derive a home/draw/away pick from model output")

    if confidence not in ("low", "medium", "high"):
        confidence = "medium"

    return {"pick": pick, "confidence": confidence, "reason": reason[:280]}


def _normalize_pick(pick_raw: str, home: str, away: str, full_text: str) -> str:
    """Map any reasonable spelling of the outcome onto home/draw/away."""
    p = str(pick_raw).strip().lower()

    if p in _VALID_PICKS:
        return p

    # Common variants for the pick field itself.
    if p in ("h", "1", "home win", "home team", "homewin"):
        return PICK_HOME
    if p in ("a", "2", "away win", "away team", "awaywin"):
        return PICK_AWAY
    if p in ("d", "x", "0", "tie", "drawn"):
        return PICK_DRAW

    # Team-name match (model answered with the winner's name).
    hl, al = home.strip().lower(), away.strip().lower()
    if hl and hl in p:
        return PICK_HOME
    if al and al in p:
        return PICK_AWAY

    # Last resort: scan the full output text for a bare keyword / team name.
    t = full_text.lower()
    if "draw" in t or "tie" in t:
        found_draw = True
    else:
        found_draw = False
    found_home = (hl and hl in t) or "home win" in t
    found_away = (al and al in t) or "away win" in t
    # Only trust the scan if it is unambiguous.
    if found_home and not found_away and not found_draw:
        return PICK_HOME
    if found_away and not found_home and not found_draw:
        return PICK_AWAY
    if found_draw and not found_home and not found_away:
        return PICK_DRAW

    return ""  # caller raises


class AIPredictor(gl.Contract):
    """
    UCL '27 Predict — "AI Call".

    A read-only companion to the per-match pari-mutuel markets. Holds NO
    funds, has no pools, and never pays out — so its blast radius is zero.

    For each fixture, GenLayer's validators reach consensus on a single
    predicted outcome — home / draw / away — before kickoff, and store it
    on-chain so the frontend can show GenLayer's own call next to the crowd's
    pari-mutuel pools.

    One deployed instance holds predictions for every 2026/27 UEFA Champions
    League fixture, keyed by the SAME match_id the markets use, so the two
    line up on the frontend.

    Consensus via the NON-COMPARATIVE equivalence principle
    (gl.eq_principle.prompt_non_comparative): the leader scrapes the live
    standings and asks the LLM for a pick; every other validator only *judges*
    the leader's answer against a fixed set of criteria, without re-scraping
    BBC and re-running the LLM themselves. That is far lighter on Bradbury's
    thin validator set than the comparative principle (which forces every
    validator to independently re-forecast the match) — and a prediction is a
    judgement, so "is this a defensible pick?" is the right question to reach
    consensus on, not "did ten validators independently guess the same coin
    flip?".
    """

    admin: Address

    # Per-match prediction state, keyed by match_id (parallel maps, matching
    # the per-match market's picks/stakes/claimed pattern).
    predicted: TreeMap[str, bool]     # match_id -> a prediction exists
    pick: TreeMap[str, str]           # match_id -> 'home' | 'draw' | 'away'
    confidence: TreeMap[str, str]     # match_id -> 'low' | 'medium' | 'high'
    reason: TreeMap[str, str]         # match_id -> one-line rationale
    home_team: TreeMap[str, str]      # match_id -> home team name
    away_team: TreeMap[str, str]      # match_id -> away team name
    match_date: TreeMap[str, str]     # match_id -> YYYY-MM-DD

    # Source the validators read for standings / form context.
    # Admin-settable so a wrong path can be corrected without a redeploy.
    source_url: str

    def __init__(self):
        self.admin = gl.message.sender_address
        # BBC UEFA Champions League table page — 36-club league phase standings.
        self.source_url = "https://www.bbc.com/sport/football/champions-league/table"

    # ------------------------------------------------------------ PREDICT

    @gl.public.write
    def predict(self, match_id: str, home: str, away: str, date: str) -> typing.Any:
        """
        Generate and store the AI's pre-match call for one fixture.

        Admin-only: unlike the market's resolve() (which reads immutable,
        pre-set teams), this method takes caller-supplied team names, so it
        is gated to the admin/cron wallet to prevent predictions for made-up
        fixtures. Intended to be fired by the cron a day before kickoff.

        Idempotent: once a match has a prediction it cannot be re-triggered,
        so the LLM cost is paid at most once per fixture.
        """
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("admin only")

        if self.predicted.get(match_id, False):
            raise gl.vm.UserError("match already has an AI prediction")

        # Capture into locals for the closure.
        source_url = self.source_url

        def gather_evidence() -> str:
            """
            The leader's `fn` for prompt_non_comparative: returns the INPUT the
            LLM task reasons over. MUST return a str (the SDK asserts this).
            No LLM call here — the framework runs the task on this input.
            """
            standings = gl.nondet.web.render(source_url, mode="text")
            return (
                "Upcoming UEFA Champions League league-phase match to predict:\n"
                f"Home team (plays at home): {home}\n"
                f"Away team: {away}\n"
                f"Match date: {date}\n\n"
                "Current UEFA Champions League league-phase table as supplementary "
                "evidence (may be sparse or empty early in the season):\n"
                f"{standings}\n"
            )

        task = (
            "You are a football analyst. Predict the result of the upcoming "
            "UEFA Champions League league-phase match described in the input, "
            "at the END OF 90 MINUTES of regulation only (league-phase matches "
            "have no extra time and no penalty shootout). "
            "Weigh each club's squad quality and known strength, recent form, "
            "and home advantage. Early in the season the standings may be "
            "sparse or empty — rely mainly on your knowledge of each club's "
            "strength in that case. Do NOT predict a scoreline, only the "
            "outcome. Respond with ONLY a single JSON object and nothing else "
            "(no prose, no markdown code fences):\n"
            '{"pick": "home", "confidence": "medium", "reason": "..."}\n'
            'where "pick" is exactly one of "home" (home team wins), "away" '
            '(away team wins) or "draw" (tie); "confidence" is exactly one of '
            '"low", "medium", "high"; and "reason" is one short sentence of at '
            "most 20 words justifying the pick."
        )

        criteria = (
            "The output is a single JSON object with keys pick, confidence and "
            "reason. pick is exactly one of \"home\", \"draw\", \"away\". "
            "confidence is one of \"low\", \"medium\", \"high\". reason is a "
            "short, on-topic justification that is consistent with the chosen "
            "pick. The pick is a plausible, defensible call for this specific "
            "fixture given the two teams involved — reject a pick that is "
            "clearly unreasonable for the matchup."
        )

        # Non-comparative consensus: leader answers, validators judge that
        # answer against `criteria` without re-forecasting. Returns a str.
        raw = gl.eq_principle.prompt_non_comparative(
            gather_evidence,
            task=task,
            criteria=criteria,
        )

        prediction = _parse_prediction(raw, home, away)

        self.predicted[match_id] = True
        self.pick[match_id] = prediction["pick"]
        self.confidence[match_id] = prediction["confidence"]
        self.reason[match_id] = prediction["reason"]
        self.home_team[match_id] = home
        self.away_team[match_id] = away
        self.match_date[match_id] = date

        return prediction

    # ------------------------------------------------------------ ADMIN

    @gl.public.write
    def reset(self, match_id: str) -> None:
        """Admin escape hatch: clear a prediction so it can be re-run (e.g.
        the fixture was postponed, or a page render produced a bad call)."""
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("admin only")
        if not self.predicted.get(match_id, False):
            raise gl.vm.UserError("no prediction to reset")
        self.predicted[match_id] = False

    @gl.public.write
    def set_source(self, url: str) -> None:
        """Admin updates the standings/form source the validators read."""
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("admin only")
        self.source_url = url

    # ------------------------------------------------------------ READ VIEWS

    @gl.public.view
    def get_prediction(self, match_id: str) -> dict[str, typing.Any]:
        if not self.predicted.get(match_id, False):
            return {"has_prediction": False}
        return {
            "has_prediction": True,
            "match_id": match_id,
            "home": self.home_team[match_id],
            "away": self.away_team[match_id],
            "date": self.match_date[match_id],
            "pick": self.pick[match_id],
            "confidence": self.confidence[match_id],
            "reason": self.reason[match_id],
        }

    @gl.public.view
    def has_prediction(self, match_id: str) -> bool:
        return self.predicted.get(match_id, False)

    @gl.public.view
    def get_source(self) -> str:
        return self.source_url
