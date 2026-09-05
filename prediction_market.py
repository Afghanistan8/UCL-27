# v0.3.2
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing
import datetime as _dt


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


# Match status values
STATUS_OPEN = "open"            # predictions accepted
STATUS_RESOLVED = "resolved"    # outcome decided, winners can claim
STATUS_REFUNDING = "refunding"  # postponed or all-correct — everyone refunds

# Valid prediction picks
PICK_HOME = "home"
PICK_DRAW = "draw"
PICK_AWAY = "away"

# How long AFTER kickoff a match must remain unplayed before anyone may move it
# to the refund path via mark_postponed(). A full match is ~2h; this grace
# window (3h) guarantees the sources have settled into showing EITHER a
# full-time score (-> resolve) OR an explicit "Postponed" tag (-> refund),
# and makes it impossible to declare a postponement before/during play.
POSTPONE_GRACE_SECS = 10800

_EPOCH = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)


def _now_epoch() -> int:
    """
    Current transaction time as a Unix epoch (seconds), read from the
    consensus message context.

    GenLayer exposes the transaction datetime as an ISO-8601 string on
    ``gl.message_raw["datetime"]`` (NOT ``gl.message.datetime`` — that field
    does not exist on this runner). It is part of the signed message and is
    identical for every validator, so comparing it against an on-chain kickoff
    time is fully deterministic and consensus-safe — no oracle, no wall clock.

    Raises (and therefore reverts the calling tx) if the datetime is missing or
    unparseable, so a time gate can never be silently bypassed.
    """
    raw = gl.message_raw["datetime"]
    dt = _dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return int((dt - _EPOCH).total_seconds())


# ---------------------------------------------------------------- RESOLUTION
# VALIDATION HELPERS
#
# These run in ordinary (deterministic) contract code AFTER consensus, never
# inside the LLM prompt. The model is treated as an untrusted extractor: it
# proposes a {score, winner}, and the code below decides whether that proposal
# is allowed to move payout state. Everything here fails CLOSED — anything
# missing, malformed, out-of-range or self-inconsistent leaves the market OPEN
# (or reverts) rather than settling on a guess.

_DIGITS = "0123456789"


def _coerce_winner(raw: typing.Any) -> int:
    """
    Allowlist the winner. Accept ONLY the exact ints -1, 0, 1, 2.

    Deliberately strict about type, not just value. The previous version tested
    `if winner < 0`, so anything not negative — 3, "1", 1.0, True — fell through
    to an `else` branch and was silently settled as a DRAW. Booleans are
    rejected explicitly and first: bool is a subclass of int in Python, and
    True == 1, so a sloppier check would settle `True` as a home win.
    """
    if type(raw) is bool:
        raise gl.vm.UserError("invalid winner")
    if type(raw) is not int:
        raise gl.vm.UserError("invalid winner")
    if raw != -1 and raw != 0 and raw != 1 and raw != 2:
        raise gl.vm.UserError("invalid winner")
    return raw


def _parse_score(raw: typing.Any) -> typing.Any:
    """
    Parse a full-time score into (home_goals, away_goals), or None if it is not
    a well-formed score.

    Accepts "2:1" and "2-1", with optional surrounding/inner spaces.
    Rejects "", "-", "FT", "2", "2:1:0", "two:one", "2–1" (en dash), negatives,
    and anything with more than one separator.

    Hand-parsed rather than regex: it keeps the accepted grammar explicit and
    auditable, and avoids depending on `re` inside the GenVM runtime.
    """
    if type(raw) is not str:
        return None
    s = raw.strip()
    if not s or len(s) > 11:
        return None

    sep_idx = -1
    sep_count = 0
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == ":" or ch == "-":
            sep_count = sep_count + 1
            if sep_idx < 0:
                sep_idx = i
        i = i + 1

    # Exactly one separator, and it must sit between two operands. This also
    # rejects a leading "-" (negative goals) and "2:1:0".
    if sep_count != 1:
        return None
    if sep_idx <= 0 or sep_idx >= len(s) - 1:
        return None

    left = s[:sep_idx].strip()
    right = s[sep_idx + 1:].strip()
    if not left or not right:
        return None
    if len(left) > 3 or len(right) > 3:
        return None

    # Explicit ASCII digit check — str.isdigit() also accepts unicode digits
    # such as '٢', which must not parse as a score.
    for ch in left:
        if ch not in _DIGITS:
            return None
    for ch in right:
        if ch not in _DIGITS:
            return None

    return (int(left), int(right))


def _score_matches_winner(home: int, away: int, winner: int) -> bool:
    """Is the parsed score actually consistent with the claimed winner?"""
    if winner == 1:
        return home > away
    if winner == 2:
        return away > home
    if winner == 0:
        return home == away
    return False


class PredictionMarket(gl.Contract):
    # Match metadata (set in constructor, immutable after)
    team1: str                       # home team
    team2: str                       # away team
    game_date: str                   # YYYY-MM-DD
    kickoff_ts: u256                 # kickoff as Unix epoch seconds — the betting deadline
    resolution_url: str              # PRIMARY source (BBC Sport) for this date
    resolution_url_2: str            # SECONDARY cross-check source (ESPN) for this date
    admin: Address                   # deployer of record — HAS NO PRIVILEGED POWERS (see below)

    # Match state
    status: str                      # 'open' | 'resolved' | 'refunding'
    result: str                      # 'home' | 'draw' | 'away' | '' if not yet resolved
    final_score: str                 # e.g. '2:1', for display
    resolve_attempts: u256           # how many times resolve() has run (anti-grief signal)
    postpone_attempts: u256          # how many times mark_postponed() has run (anti-grief signal)

    # Pari-mutuel pools (in wei)
    pool_home: u256
    pool_draw: u256
    pool_away: u256

    # Per-user state
    picks: TreeMap[Address, str]      # user -> pick
    stakes: TreeMap[Address, u256]    # user -> stake amount
    claimed: TreeMap[Address, bool]   # user -> has claimed/refunded yet

    # Sum of WINNING-side stakes already claimed. Lets the final winner sweep
    # the integer-division remainder so no wei is ever locked (see claim()).
    winning_stake_claimed: u256

    # Minimum stake (2 GEN)
    MIN_STAKE: u256

    def __init__(self, team1: str, team2: str, game_date: str, kickoff_ts: int):
        """
        Initialize a single-match prediction market for a 2026/27 UEFA
        Champions League fixture.

        Args:
            team1: Home team name (exact BBC Sport spelling)
            team2: Away team name (exact BBC Sport spelling)
            game_date: YYYY-MM-DD format
            kickoff_ts: Kickoff time as a Unix epoch (seconds, UTC). This is the
                betting deadline: submit_prediction() reverts at or after this
                instant, so no stake can ever be placed once the match has
                started (or, therefore, once the result is known).
        """
        self.team1 = team1
        self.team2 = team2
        self.game_date = game_date
        self.kickoff_ts = u256(kickoff_ts)
        # PRIMARY: BBC Sport scores-fixtures by date. SECONDARY: ESPN soccer
        # scoreboard by date. resolve() renders both and only settles when
        # they AGREE on the same {score, winner} — see resolve(). Date pages
        # list every match kicking off that day (multiple competitions); the
        # LLM prompt matches the fixture by CLUB IDENTITY.
        self.resolution_url = (
            "https://www.bbc.com/sport/football/scores-fixtures/" + game_date
        )
        self.resolution_url_2 = (
            "https://www.espn.com/soccer/scoreboard/_/date/"
            + game_date.replace("-", "")
        )
        self.admin = gl.message.sender_address

        self.status = STATUS_OPEN
        self.result = ""
        self.final_score = ""
        self.resolve_attempts = u256(0)
        self.postpone_attempts = u256(0)
        self.winning_stake_claimed = u256(0)

        self.pool_home = u256(0)
        self.pool_draw = u256(0)
        self.pool_away = u256(0)

        self.MIN_STAKE = u256(2_000_000_000_000_000_000)  # 2 GEN

    # ------------------------------------------------------------ PREDICTIONS

    @gl.public.write.payable
    def submit_prediction(self, pick: str) -> None:
        """User submits a pick with stake (>= 2 GEN). One prediction per user."""
        if self.status != STATUS_OPEN:
            raise gl.vm.UserError("predictions closed")

        # Fixture-specific betting deadline / irreversible close. Staking is
        # refused at or after kickoff, using the consensus transaction time
        # (gl.message_raw["datetime"]) versus the immutable on-chain kickoff.
        # This closes the market to new money the moment the match starts, so
        # nobody can stake after kickoff or once the result becomes known.
        if _now_epoch() >= int(self.kickoff_ts):
            raise gl.vm.UserError("betting closed: match has kicked off")

        if pick != PICK_HOME and pick != PICK_DRAW and pick != PICK_AWAY:
            raise gl.vm.UserError("pick must be 'home', 'draw', or 'away'")

        value = gl.message.value
        if value < self.MIN_STAKE:
            raise gl.vm.UserError("minimum stake is 2 GEN")

        sender = gl.message.sender_address
        if sender in self.picks:
            raise gl.vm.UserError("already predicted this match")

        self.picks[sender] = pick
        self.stakes[sender] = value

        if pick == PICK_HOME:
            self.pool_home = self.pool_home + value
        elif pick == PICK_DRAW:
            self.pool_draw = self.pool_draw + value
        else:
            self.pool_away = self.pool_away + value

    # ------------------------------------------------------------ RESOLUTION

    @gl.public.write
    def resolve(self) -> typing.Any:
        """
        Resolve the match from the FULL-TIME SCORE after 90 minutes plus
        stoppage time, read on-chain via LLM consensus. UEFA Champions League
        LEAGUE-PHASE matches have no extra time and no penalty shootout.

        Public + autonomous by design (anyone can trigger settlement — no admin
        gate on money). Two hardening measures against griefing/wrong reads:

        - Anti-grief: resolve() no-ops immediately once the match has settled
          (status leaves OPEN), and increments `resolve_attempts` so repeated
          pre-finish calls are observable. The off-chain cron paces calls
          (RESOLVE_RETRY_HOURS); the contract itself refuses to re-settle.
        - Multi-source: renders BBC (primary) AND ESPN (secondary) and only
          accepts a result the two sources AGREE on. Disagreement or an
          unfinished primary returns winner = -1, leaving the match OPEN.

        Consensus is via gl.eq_principle.strict_eq over the normalized
        {score, winner, agreement, secondary_present} — an objective fact, so
        strict equality is correct.

        HARDENING (v0.3.2). Settlement now requires ALL of the following, each
        enforced in deterministic contract code rather than trusted to the LLM:

        1. POST-KICKOFF BOUNDARY — reverts if called before kickoff_ts, using
           the same consensus clock as submit_prediction(). Checked BEFORE the
           attempt counter and BEFORE any web render, so a premature call is
           cheap and cannot even reach the model.
        2. INDEPENDENT CORROBORATION — BOTH sources must have rendered AND
           agreed. A blank/failed ESPN can never settle a market. This is
           deliberately stricter than mark_postponed(), which may fall back to
           an explicit primary alone: that path only opens 1:1 refunds, whereas
           this one pays winners.
        3. WINNER ALLOWLIST — only the exact ints -1/0/1/2 are accepted.
        4. SCORE VALIDATION — the score must parse as home:away non-negative
           integers AND agree with the claimed winner.

        Any failure leaves result / final_score / status / pools untouched so
        the cron can simply retry later.
        """
        if self.status != STATUS_OPEN:
            raise gl.vm.UserError("match is not open for resolution")

        # ---- (1) POST-KICKOFF BOUNDARY -------------------------------------
        # Before the counter and before any nondet work: a pre-kickoff call is
        # rejected without spending a web render or an LLM call.
        if _now_epoch() < int(self.kickoff_ts):
            raise gl.vm.UserError("too early: match has not kicked off")

        self.resolve_attempts = self.resolve_attempts + u256(1)

        # Capture self values into locals for the closure
        resolution_url = self.resolution_url
        resolution_url_2 = self.resolution_url_2
        team1 = self.team1
        team2 = self.team2

        def get_match_result() -> typing.Any:
            primary = gl.nondet.web.render(resolution_url, mode="text")
            # A failed or blank secondary is NOT a fallback to primary-only —
            # it makes the read uncorroborated, and the on-chain gate below
            # refuses to settle. secondary_present travels through strict_eq so
            # validators cannot disagree about whether ESPN was actually read.
            try:
                secondary = gl.nondet.web.render(resolution_url_2, mode="text")
            except Exception:
                secondary = ""
            secondary_present = bool(secondary.strip())

            task = f"""
You are settling a UEFA Champions League match. Find the FULL-TIME score
after 90 minutes plus stoppage time. For league-phase matches there is no
extra time and no penalty shootout. Ignore any other competition on the page.

Match:
  Home team: {team1}
  Away team: {team2}

Match teams by CLUB IDENTITY, not exact spelling. Use these equivalences:
"Man City"/"Manchester City" = "Manchester City"; "Man United"/"Man Utd" =
"Manchester United"; "Atletico"/"Atlético Madrid"/"Atlético de Madrid" =
"Atletico Madrid"; "Barça"/"FC Barcelona" = "Barcelona"; "Betis" = "Real
Betis"; "Bayern München"/"FC Bayern" = "Bayern Munich"; "Dortmund"/"BVB" =
"Borussia Dortmund"; "Leipzig" = "RB Leipzig"; "VfB Stuttgart" = "Stuttgart";
"Inter"/"Internazionale"/"FC Internazionale Milano" = "Inter Milan"; "SSC
Napoli" = "Napoli"; "AS Roma" = "Roma"; "Como 1907" = "Como"; "Paris
St-Germain"/"PSG" = "Paris Saint-Germain"; "LOSC Lille" = "Lille"; "RC
Lens" = "Lens"; "FC Porto" = "Porto"; "Sporting Lisbon"/"Sporting Clube de
Portugal" = "Sporting CP"; "PSV" = "PSV Eindhoven"; "Club Bruges" = "Club
Brugge"; "Fenerbahçe" = "Fenerbahce"; "AEK" = "AEK Athens"; "LASK Linz" =
"LASK"; "Bodø/Glimt"/"FK Bodo/Glimt" = "Bodo/Glimt"; "Slavia Praha"/"SK
Slavia Praha" = "Slavia Prague"; "Shakhtar" = "Shakhtar Donetsk"; "Sabah
FK"/"Sabah FC" = "Sabah"; "Viking FK" = "Viking".

PRIMARY source (BBC), authoritative:
{primary}
End of PRIMARY.

SECONDARY source (ESPN), cross-check only (may be empty):
{secondary}
End of SECONDARY.

Rules — classify EACH source INDEPENDENTLY first, then compare:
- If the SECONDARY is empty, missing, or failed to render:
    winner = -1, score = "-", agreement = "missing-secondary"
- If the PRIMARY has not finished (kick-off time shown, live, HT, or the score
  is absent): winner = -1, score = "-", agreement = "unresolved"
- If BOTH sources show a finished result but DISAGREE on the winner or score:
    winner = -1, score = "-", agreement = "conflict"
- If BOTH sources show the SAME finished full-time result:
    score = "H:A" (e.g. "2:1"), winner = 1/0/2, agreement = "agree"
- NEVER settle from one source. NEVER guess. NEVER use extra time or penalties
  — this is a 90-minutes-plus-stoppage league-phase market.
- Do not use pre-match odds, predicted scores, or another match on the page.

Respond ONLY with this JSON, nothing else:
{{
    "score": str,           // full-time score as home:away, e.g. "2:1", or "-" if unresolved
    "winner": int,          // 1 = {team1} won, 2 = {team2} won, 0 = draw, -1 = not resolved
    "agreement": str        // "agree" | "conflict" | "unresolved" | "missing-secondary"
}}
Your response must be parseable JSON with no prefix or suffix.
"""
            result = (
                gl.nondet.exec_prompt(task).replace("```json", "").replace("```", "")
            )
            parsed = json.loads(result)

            # Normalise into a fixed, comparable shape for strict_eq. `winner`
            # is passed through UNCOERCED so a bad type reaches the allowlist
            # below and is rejected there rather than being silently cast.
            return {
                "score": parsed.get("score", "-"),
                "winner": parsed.get("winner", -1),
                "agreement": str(parsed.get("agreement", "")),
                "secondary_present": secondary_present,
            }

        result_json = gl.eq_principle.strict_eq(get_match_result)

        # ---- DETERMINISTIC SETTLEMENT GATE ---------------------------------
        # Everything below runs on the agreed consensus payload, in ordinary
        # contract code. The LLM is never the only gate.

        agreement = str(result_json.get("agreement", "")).strip().lower()
        secondary_present = bool(result_json.get("secondary_present", False))

        # (2) INDEPENDENT CORROBORATION.
        # A missing secondary is forced uncorroborated even if the model claimed
        # "agree" — the render either happened or it did not.
        if not secondary_present:
            return {
                "score": result_json.get("score", "-"),
                "winner": result_json.get("winner", -1),
                "agreement": agreement,
                "secondary_present": False,
                "settled": False,
                "reason": "missing_secondary",
            }

        if agreement != "agree":
            return {
                "score": result_json.get("score", "-"),
                "winner": result_json.get("winner", -1),
                "agreement": agreement,
                "secondary_present": True,
                "settled": False,
                "reason": "source_conflict_or_uncorroborated",
            }

        # (3) WINNER ALLOWLIST — reverts on 3, "1", 1.0, True, None, …
        winner = _coerce_winner(result_json.get("winner"))

        if winner == -1:
            return {
                "score": result_json.get("score", "-"),
                "winner": -1,
                "agreement": agreement,
                "secondary_present": True,
                "settled": False,
                "reason": "unresolved",
            }

        # (4) SCORE VALIDATION + CONSISTENCY WITH THE WINNER.
        parsed_score = _parse_score(result_json.get("score"))
        if parsed_score is None:
            raise gl.vm.UserError("malformed score")

        home_goals = parsed_score[0]
        away_goals = parsed_score[1]
        if not _score_matches_winner(home_goals, away_goals, winner):
            raise gl.vm.UserError("inconsistent score and winner")

        # ---- ONLY NOW may payout state change ------------------------------
        # Explicit mapping only: no `else` fallthrough that could turn an
        # unexpected value into a draw.
        if winner == 1:
            self.result = PICK_HOME
        elif winner == 2:
            self.result = PICK_AWAY
        elif winner == 0:
            self.result = PICK_DRAW
        else:
            raise gl.vm.UserError("invalid winner")

        # Store the NORMALISED score, so "2-1" is persisted as "2:1".
        self.final_score = str(home_goals) + ":" + str(away_goals)

        # ---- Determine winning pool ----
        if self.result == PICK_HOME:
            winning_pool = self.pool_home
        elif self.result == PICK_DRAW:
            winning_pool = self.pool_draw
        else:
            winning_pool = self.pool_away

        total_pool = self.pool_home + self.pool_draw + self.pool_away

        # ---- Edge cases that trigger refund path (Option X) ----
        # (a) Nobody picked correctly — refund everyone
        # (b) Everyone picked correctly (100% of pool is on winning side) — refund everyone
        if winning_pool == u256(0) or winning_pool == total_pool:
            self.status = STATUS_REFUNDING
        else:
            self.status = STATUS_RESOLVED

        return {
            "score": self.final_score,
            "winner": winner,
            "agreement": agreement,
            "secondary_present": True,
            "settled": True,
            "reason": "settled",
        }

    # ------------------------------------------------------------ CLAIM

    @gl.public.write
    def claim(self) -> None:
        """Winning predictor claims their pari-mutuel share."""
        if self.status != STATUS_RESOLVED:
            raise gl.vm.UserError("match not in claimable state")

        sender = gl.message.sender_address
        if sender not in self.picks:
            raise gl.vm.UserError("no prediction to claim")

        if self.claimed.get(sender, False):
            raise gl.vm.UserError("already claimed")

        # Mark claimed FIRST (reentrancy safety, matches our smoke test pattern)
        self.claimed[sender] = True

        # If user picked wrong, claim is a no-op (just marks as settled)
        if self.picks[sender] != self.result:
            return

        # Pari-mutuel payout: stake * (total_pool / winning_pool).
        if self.result == PICK_HOME:
            winning_pool = self.pool_home
        elif self.result == PICK_DRAW:
            winning_pool = self.pool_draw
        else:
            winning_pool = self.pool_away

        total_pool = self.pool_home + self.pool_draw + self.pool_away
        stake = self.stakes[sender]

        # Track how much of the winning side has now claimed. Integer division
        # in the formula below rounds each payout DOWN, so a few wei of "dust"
        # would otherwise be stranded forever. Instead, the LAST winner to
        # claim (the one whose stake completes the winning pool) sweeps the
        # entire remaining contract balance — their fair share PLUS all the
        # accumulated rounding dust. Nothing is ever permanently locked.
        self.winning_stake_claimed = self.winning_stake_claimed + stake
        if self.winning_stake_claimed >= winning_pool:
            payout = u256(self.balance)  # final winner mops up the dust
        else:
            payout = u256((stake * total_pool) // winning_pool)

        _Recipient(sender).emit_transfer(value=payout)

    # ------------------------------------------------------------ REFUND

    @gl.public.write
    def mark_postponed(self) -> typing.Any:
        """
        Move a real-world postponed/cancelled/abandoned fixture to the refund
        path — PERMISSIONLESSLY and only when the sources CONFIRM it.

        This is deliberately NOT an admin power. There is no privileged key in
        this contract: just as anyone can call resolve() to settle a finished
        match, anyone can call mark_postponed() to open refunds for a match that
        was called off. What makes it safe is that it cannot be asserted — it
        must be *verified* against the same public sources, under the same
        validator consensus, as a result is.

        Constraints (all enforced on-chain):
        1. Only while status is OPEN — it can never unwind a settled market.
        2. Only after kickoff + POSTPONE_GRACE_SECS — a postponement cannot be
           declared before or during the match window, so it can't be used to
           dodge a bet mid-play. By the time it's callable, the sources show
           either a full-time score or an explicit postponement.
        3. Each source is classified INDEPENDENTLY ("postponed" / "finished" /
           "unknown", plus "unavailable" for a missing secondary) and the two
           statuses are cross-checked ON-CHAIN, after consensus under
           gl.eq_principle.strict_eq:
             - If EITHER source shows a FINISHED result -> REVERT. This rejects
               both a plainly finished match AND a conflict (one source says
               postponed, the other finished): a decided match can never be
               turned into a refund.
             - The PRIMARY (authoritative) source must itself say postponed.
             - The SECONDARY must AGREE (also postponed). If the secondary is
               unavailable, fall back to primary-only ONLY when the primary is
               EXPLICIT (contains a postponed / called-off / cancelled /
               suspended / abandoned word); otherwise stay OPEN. Any other
               combination (e.g. secondary "unknown") stays OPEN.
           A suspended / abandoned / called-off fixture with NO full-time score
           is treated as postponed; a match that kicked off is only postponable
           if a source EXPLICITLY says it was abandoned / not completed.

        On confirmation, status -> REFUNDING and every staker can reclaim their
        OWN stake 1:1 via refund(). Nobody — caller included — can be paid a
        result this way; the only reachable outcome is a universal 1:1 refund.
        Preferring safety, ANY ambiguity or conflict leaves the market OPEN.
        """
        if self.status != STATUS_OPEN:
            raise gl.vm.UserError("can only postpone matches that are still open")

        # Time constraint: no postponement can be declared until the match
        # should already have been played and reported. Uses the consensus tx
        # time vs the immutable on-chain kickoff.
        if _now_epoch() < int(self.kickoff_ts) + POSTPONE_GRACE_SECS:
            raise gl.vm.UserError("too early: match may still be in play")

        self.postpone_attempts = self.postpone_attempts + u256(1)

        resolution_url = self.resolution_url
        resolution_url_2 = self.resolution_url_2
        team1 = self.team1
        team2 = self.team2
        game_date = self.game_date

        def check_postponed() -> typing.Any:
            primary = gl.nondet.web.render(resolution_url, mode="text")
            try:
                secondary = gl.nondet.web.render(resolution_url_2, mode="text")
            except Exception:
                secondary = ""
            secondary_present = bool(secondary.strip())

            task = f"""
You are checking whether a scheduled UEFA Champions League fixture was
POSTPONED (also called off, cancelled, suspended, or abandoned) rather than
played to a finish.

Fixture:
  Home team: {team1}
  Away team: {team2}
  Scheduled date: {game_date}

Match teams by CLUB IDENTITY, not exact spelling. Examples: "Man
City"/"Manchester City" = "Manchester City"; "Man United"/"Man Utd" =
"Manchester United"; "Atletico"/"Atlético Madrid" = "Atletico Madrid";
"Barça"/"FC Barcelona" = "Barcelona"; "Bayern München"/"FC Bayern" = "Bayern
Munich"; "Dortmund"/"BVB" = "Borussia Dortmund"; "Inter"/"Internazionale" =
"Inter Milan"; "Paris St-Germain"/"PSG" = "Paris Saint-Germain"; "Sporting
Lisbon" = "Sporting CP"; "PSV" = "PSV Eindhoven"; "Fenerbahçe" = "Fenerbahce";
"Bodø/Glimt" = "Bodo/Glimt"; "Slavia Praha" = "Slavia Prague"; "Shakhtar" =
"Shakhtar Donetsk".

PRIMARY source (BBC), authoritative:
{primary}
End of PRIMARY.

SECONDARY source (ESPN), independent cross-check (may be empty):
{secondary}
End of SECONDARY.

Classify EACH source INDEPENDENTLY. For a given source, the status is:
- "postponed": that source EXPLICITLY marks THIS fixture as postponed, called
  off, cancelled, suspended, or abandoned, AND shows NO full-time score for it.
  A match that started but was then abandoned / not completed counts as
  "postponed" ONLY if the source explicitly says it was abandoned or not
  completed (no full-time score).
- "finished": that source shows a FULL-TIME / final score for this fixture
  (the match was played to completion).
- "unknown": you cannot clearly tell from that source — the fixture is absent,
  merely scheduled/upcoming, in progress, or lacks explicit wording. Absence of
  a score, or of the fixture, is "unknown", NOT "postponed".

Rules:
- Judge the PRIMARY only from the PRIMARY text, and the SECONDARY only from the
  SECONDARY text. Do NOT let one source's wording decide the other's status.
- If the SECONDARY text is empty/blank, set "secondary_status" to "unavailable".
- Be conservative: only say "postponed" when the wording is EXPLICIT. When in
  doubt, use "unknown".
- "primary_explicit" is true ONLY if the PRIMARY text contains an explicit
  postponed / called-off / cancelled / suspended / abandoned wording for this
  fixture (not merely a missing score).

Respond ONLY with this JSON, nothing else:
{{
    "primary_status": str,    // "postponed" | "finished" | "unknown"
    "secondary_status": str,  // "postponed" | "finished" | "unknown" | "unavailable"
    "primary_explicit": bool  // true only on explicit postponed-type wording in PRIMARY
}}
Your response must be parseable JSON with no prefix or suffix.
"""
            result = (
                gl.nondet.exec_prompt(task).replace("```json", "").replace("```", "")
            )
            parsed = json.loads(result)
            # Normalise to a fixed, comparable shape so strict_eq compares only
            # constrained enum/bool fields (free text never reaches byte-exact
            # consensus). If the model omitted the secondary and none was
            # rendered, record it as "unavailable".
            p = str(parsed.get("primary_status", "unknown"))
            s = str(parsed.get("secondary_status", "unknown"))
            if not secondary_present:
                s = "unavailable"
            return {
                "primary_status": p,
                "secondary_status": s,
                "primary_explicit": bool(parsed.get("primary_explicit", False)),
            }

        verdict = gl.eq_principle.strict_eq(check_postponed)

        primary_status = verdict["primary_status"]
        secondary_status = verdict["secondary_status"]
        primary_explicit = bool(verdict["primary_explicit"])

        # --- Conflict / safety enforcement (deterministic, on the agreed verdict).
        # Prefer safety: any ambiguity or conflict leaves the market OPEN so it
        # can still be resolved normally later.

        # 1. A FINISHED result on EITHER source blocks the refund path. This
        #    covers both a plainly finished match and a CONFLICT (one source
        #    postponed, the other finished) — a decided match is never refunded.
        if primary_status == "finished" or secondary_status == "finished":
            raise gl.vm.UserError(
                "a source reports a finished result; not postponed "
                "(primary: " + str(primary_status)
                + ", secondary: " + str(secondary_status) + ")"
            )

        # 2. The authoritative (primary) source must itself confirm postponement.
        if primary_status != "postponed":
            raise gl.vm.UserError(
                "primary source does not confirm postponement (primary: "
                + str(primary_status) + ")"
            )

        # 3. Cross-check the secondary and set an explicit agreement label.
        if secondary_status == "postponed":
            agreement = "agree"
        elif secondary_status == "unavailable":
            # Safe missing-secondary policy: fall back to primary-only ONLY when
            # the primary is EXPLICIT; otherwise stay OPEN on weak evidence.
            if not primary_explicit:
                raise gl.vm.UserError(
                    "secondary source unavailable and primary not explicit; "
                    "staying open (primary-only evidence too weak)"
                )
            agreement = "primary-only"
        else:
            # secondary is "unknown" (or unexpected) — it does not confirm.
            raise gl.vm.UserError(
                "secondary source does not confirm postponement (secondary: "
                + str(secondary_status) + "); staying open"
            )

        self.status = STATUS_REFUNDING
        return {
            "primary_status": primary_status,
            "secondary_status": secondary_status,
            "agreement": agreement,
        }

    @gl.public.write
    def refund(self) -> None:
        """User reclaims their original stake when match is in refunding state."""
        if self.status != STATUS_REFUNDING:
            raise gl.vm.UserError("refunds not available")

        sender = gl.message.sender_address
        if sender not in self.stakes:
            raise gl.vm.UserError("no prediction to refund")

        if self.claimed.get(sender, False):
            raise gl.vm.UserError("already refunded")

        self.claimed[sender] = True
        stake = self.stakes[sender]
        _Recipient(sender).emit_transfer(value=stake)

    # ------------------------------------------------------------ READ VIEWS

    @gl.public.view
    def get_match_info(self) -> dict[str, typing.Any]:
        return {
            "team1": self.team1,
            "team2": self.team2,
            "game_date": self.game_date,
            "kickoff_ts": self.kickoff_ts,
            "status": self.status,
            "result": self.result,
            "final_score": self.final_score,
            "admin": str(self.admin.as_hex),
            "resolve_attempts": self.resolve_attempts,
            "postpone_attempts": self.postpone_attempts,
        }

    @gl.public.view
    def get_pools(self) -> dict[str, u256]:
        return {
            "home": self.pool_home,
            "draw": self.pool_draw,
            "away": self.pool_away,
            "total": self.pool_home + self.pool_draw + self.pool_away,
        }

    @gl.public.view
    def get_my_prediction(self, user: Address) -> dict[str, typing.Any]:
        if user not in self.picks:
            return {"has_predicted": False}
        return {
            "has_predicted": True,
            "pick": self.picks[user],
            "stake": self.stakes[user],
            "claimed": self.claimed.get(user, False),
        }

    @gl.public.view
    def expected_payout(self, user: Address) -> u256:
        """Hypothetical payout if user's pick wins. UI display helper."""
        if user not in self.picks:
            return u256(0)
        pick = self.picks[user]
        stake = self.stakes[user]
        if pick == PICK_HOME:
            winning_pool = self.pool_home
        elif pick == PICK_DRAW:
            winning_pool = self.pool_draw
        else:
            winning_pool = self.pool_away
        if winning_pool == u256(0):
            return u256(0)
        total_pool = self.pool_home + self.pool_draw + self.pool_away
        return u256((stake * total_pool) // winning_pool)

    @gl.public.view
    def get_contract_balance(self) -> u256:
        return self.balance
