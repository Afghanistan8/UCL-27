# Focused tests for the resolve() hardening (v0.3.2).
#
# Steward request: "harden resolve() before settlement: enforce a post-kickoff
# boundary, require independently corroborated source agreement, accept only
# winner values -1/0/1/2, and validate the score and its consistency with the
# winner before changing payout state. Add focused tests for a missing
# secondary, source conflict, invalid winner, malformed or inconsistent score,
# and premature resolution."
#
# One test per steward case, plus a happy path proving settlement still works.
#
# Run:  python tests/test_resolve_hardening.py
#   or: python -m pytest tests/test_resolve_hardening.py -v
#
# Time model matches tests/test_deadline_and_postpone.py: gltest's vm.warp()
# moves datetime.now(), and we ALSO set gl.message_raw["datetime"] because that
# is what the contract's _now_epoch() actually reads.

import os
import sys
import json
import datetime as _dt

from gltest.direct import VMContext, deploy_contract, create_address

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "..", "prediction_market.py")

# Real Madrid vs Inter Milan, MD1 — kickoff 2026-09-08T19:00:00Z.
KICKOFF_TS = 1789232400
TWO_GEN = 2_000_000_000_000_000_000


def _iso(epoch: int) -> str:
    return (
        _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)
        + _dt.timedelta(seconds=epoch)
    ).isoformat().replace("+00:00", "Z")


def _at(vm, epoch: int) -> None:
    iso = _iso(epoch)
    vm.warp(iso)
    if "genlayer.gl" in sys.modules:
        sys.modules["genlayer.gl"].message_raw["datetime"] = iso


def _fenced(obj) -> str:
    """Wrap JSON in a ```json fence, as real LLMs do. The contract strips the
    fence then json.loads(). Fenced text is not valid JSON, so gltest's mock
    passes it through as a raw string instead of auto-parsing it to a dict —
    which is what lets us inject deliberately bad types like "1" or null."""
    return "```json\n" + json.dumps(obj) + "\n```"


_FT_PAGE = "Champions League. Real Madrid 2-1 Inter Milan. Full time. Match finished."
_UPCOMING_PAGE = "Champions League. Real Madrid v Inter Milan. Kick off 19:00. Not started."


def _mock_sources(vm, primary=_FT_PAGE, secondary=_FT_PAGE):
    """Set both rendered pages. Pass secondary=None to leave ESPN unmocked
    entirely (render raises -> contract catches -> secondary_present False)."""
    vm.mock_web(r"bbc\.com", {"status": 200, "body": primary})
    if secondary is not None:
        vm.mock_web(r"espn\.com", {"status": 200, "body": secondary})


def _mock_verdict(vm, score, winner, agreement):
    """What the consensus JSON says. The contract re-validates all of it."""
    vm.mock_llm(
        r"FULL-TIME score",
        _fenced({"score": score, "winner": winner, "agreement": agreement}),
    )


def _assert_untouched(c, why=""):
    """No payout state may have moved."""
    info = c.get_match_info()
    assert info["status"] == "open", f"{why}: status={info['status']}"
    assert info["result"] == "", f"{why}: result={info['result']!r}"
    assert info["final_score"] == "", f"{why}: final_score={info['final_score']!r}"


# ---- harness -------------------------------------------------------------

_RESULTS = []


def _run(name, fn):
    vm = VMContext()
    vm.sender = create_address("deployer")
    _at(vm, KICKOFF_TS - 7 * 24 * 3600)
    try:
        with vm.activate():
            c = deploy_contract(CONTRACT, vm, "Real Madrid", "Inter Milan",
                                "2026-09-08", KICKOFF_TS)
            fn(vm, c)
        _RESULTS.append((name, True, ""))
        print(f"  PASS  {name}")
    except Exception as e:
        _RESULTS.append((name, False, str(e)))
        print(f"  FAIL  {name}: {e}")


def _stake(vm, c, who, pick, amount=TWO_GEN):
    vm.sender = create_address(who)
    vm.value = amount
    c.submit_prediction(pick)
    vm.value = 0


def _stake_both_sides(vm, c):
    """Two sides staked so a settle lands on RESOLVED, not the refund path."""
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")


# ========================================================================
# 1. PREMATURE RESOLUTION
# ========================================================================

def test_premature_resolution_reverts_before_kickoff(vm, c):
    _stake_both_sides(vm, c)

    # One second before kickoff. Deliberately mock a finished page + a valid
    # "agree" verdict: even with perfect data, the time gate must refuse.
    _at(vm, KICKOFF_TS - 1)
    _mock_sources(vm)
    _mock_verdict(vm, "2:1", 1, "agree")

    before = int(c.get_match_info()["resolve_attempts"])
    vm.sender = create_address("anyone")
    with vm.expect_revert("too early"):
        c.resolve()

    _assert_untouched(c, "premature resolve")
    after = int(c.get_match_info()["resolve_attempts"])
    # The gate runs BEFORE the counter, so a premature call must not even be
    # recorded as an attempt (and must not have reached the LLM).
    assert after == before, f"resolve_attempts moved {before} -> {after}"


def test_resolution_allowed_exactly_at_kickoff(vm, c):
    # Boundary is `now < kickoff` reverts, so exactly AT kickoff is allowed
    # through the time gate. It still will not settle (not finished yet).
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS)
    _mock_sources(vm, primary=_UPCOMING_PAGE, secondary=_UPCOMING_PAGE)
    _mock_verdict(vm, "-", -1, "unresolved")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    # The gates are ordered secondary -> agreement -> winner, so an
    # agreement of "unresolved" is caught by the agreement gate (it is not
    # "agree") before the winner == -1 branch is ever reached. Either way the
    # market must not settle; that is what this test is really asserting.
    assert out["reason"] == "source_conflict_or_uncorroborated", out
    _assert_untouched(c, "at kickoff, unfinished")
    # The call DID pass the time gate, so the attempt is recorded.
    assert int(c.get_match_info()["resolve_attempts"]) == 1


# ========================================================================
# 2. MISSING SECONDARY
# ========================================================================

def test_missing_secondary_does_not_settle(vm, c):
    # ESPN renders BLANK. The old code called this "primary-only" and settled.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm, primary=_FT_PAGE, secondary="")
    # Even if the model insists it agrees, an absent secondary cannot corroborate.
    _mock_verdict(vm, "2:1", 1, "agree")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    assert out["reason"] == "missing_secondary", out
    _assert_untouched(c, "blank secondary")


def test_secondary_render_failure_does_not_settle(vm, c):
    # ESPN not mocked at all -> render raises -> contract catches -> uncorroborated.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm, primary=_FT_PAGE, secondary=None)
    _mock_verdict(vm, "2:1", 1, "agree")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    assert out["reason"] == "missing_secondary", out
    _assert_untouched(c, "secondary render failed")


def test_primary_only_agreement_is_rejected(vm, c):
    # The old vocabulary. Both pages present, but the model reports
    # "primary-only" -> not "agree" -> must not settle.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "2:1", 1, "primary-only")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    assert out["reason"] == "source_conflict_or_uncorroborated", out
    _assert_untouched(c, "primary-only")


# ========================================================================
# 3. SOURCE CONFLICT
# ========================================================================

def test_source_conflict_does_not_settle(vm, c):
    # BBC says 2-1 home, ESPN says 1-2 away.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(
        vm,
        primary="Champions League. Real Madrid 2-1 Inter Milan. Full time.",
        secondary="Champions League. Real Madrid 1-2 Inter Milan. Full time.",
    )
    _mock_verdict(vm, "-", -1, "conflict")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    assert out["reason"] == "source_conflict_or_uncorroborated", out
    _assert_untouched(c, "source conflict")


def test_conflict_claiming_agree_still_blocked_by_winner_minus_one(vm, c):
    # Defence in depth: even if the model mislabels a conflict as "agree",
    # winner = -1 still stops settlement.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "-", -1, "agree")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is False, out
    assert out["reason"] == "unresolved", out
    _assert_untouched(c, "winner -1 under agree")


# ========================================================================
# 4. INVALID WINNER
# ========================================================================

def _expect_invalid_winner(vm, c, bad_winner):
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "2:1", bad_winner, "agree")
    vm.sender = create_address("cron")
    with vm.expect_revert("invalid winner"):
        c.resolve()
    _assert_untouched(c, f"winner={bad_winner!r}")


def test_invalid_winner_out_of_range_does_not_settle(vm, c):
    # 3 is not in {-1,0,1,2}. Under the old `if winner < 0` test it fell
    # through the else-branch and settled as a DRAW.
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, 3)


def test_invalid_winner_large_does_not_settle(vm, c):
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, 9)


def test_invalid_winner_string_does_not_settle(vm, c):
    # "1" is a string, not an int.
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, "1")


def test_invalid_winner_null_does_not_settle(vm, c):
    # JSON null -> Python None.
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, None)


def test_invalid_winner_bool_does_not_settle(vm, c):
    # JSON true -> Python True. bool subclasses int and True == 1, so a
    # looser check would have settled this as a HOME WIN.
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, True)


def test_invalid_winner_float_does_not_settle(vm, c):
    # 1.0 == 1 but is not an int.
    _stake_both_sides(vm, c)
    _expect_invalid_winner(vm, c, 1.0)


# ========================================================================
# 5. MALFORMED SCORE
# ========================================================================

def _expect_malformed_score(vm, c, bad_score):
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, bad_score, 1, "agree")
    vm.sender = create_address("cron")
    with vm.expect_revert("malformed score"):
        c.resolve()
    _assert_untouched(c, f"score={bad_score!r}")


def test_malformed_score_empty_does_not_settle(vm, c):
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "")


def test_malformed_score_placeholder_does_not_settle(vm, c):
    # "-" with a winner of 1 is self-contradictory.
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "-")


def test_malformed_score_ft_does_not_settle(vm, c):
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "FT")


def test_malformed_score_single_number_does_not_settle(vm, c):
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "2")


def test_malformed_score_three_parts_does_not_settle(vm, c):
    # e.g. an aggregate or a penalty shootout leaking in.
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "2:1:0")


def test_malformed_score_words_does_not_settle(vm, c):
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "two:one")


def test_malformed_score_en_dash_does_not_settle(vm, c):
    # En dashes are not the ASCII separators we accept.
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, "2–1–0")


def test_malformed_score_non_string_does_not_settle(vm, c):
    # JSON number instead of a string.
    _stake_both_sides(vm, c)
    _expect_malformed_score(vm, c, 21)


# ========================================================================
# 6. SCORE INCONSISTENT WITH WINNER
# ========================================================================

def _expect_inconsistent(vm, c, score, winner):
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, score, winner, "agree")
    vm.sender = create_address("cron")
    with vm.expect_revert("inconsistent score and winner"):
        c.resolve()
    _assert_untouched(c, f"score={score} winner={winner}")


def test_inconsistent_home_score_away_winner(vm, c):
    # 2:1 is a home win, but winner claims away.
    _stake_both_sides(vm, c)
    _expect_inconsistent(vm, c, "2:1", 2)


def test_inconsistent_draw_score_home_winner(vm, c):
    _stake_both_sides(vm, c)
    _expect_inconsistent(vm, c, "1:1", 1)


def test_inconsistent_away_score_draw_winner(vm, c):
    _stake_both_sides(vm, c)
    _expect_inconsistent(vm, c, "0:3", 0)


# ========================================================================
# 7. HAPPY PATH — settlement still works
# ========================================================================

def test_agreeing_sources_valid_score_settles_after_kickoff(vm, c):
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "2:1", 1, "agree")

    vm.sender = create_address("cron")
    out = c.resolve()
    assert out["settled"] is True, out

    info = c.get_match_info()
    assert info["status"] == "resolved", info
    assert info["result"] == "home", info
    assert info["final_score"] == "2:1", info
    assert int(info["resolve_attempts"]) == 1


def test_settles_draw_and_away_correctly(vm, c):
    # 0 -> draw (and with only home/away staked, a draw means nobody won ->
    # the existing refund rule applies).
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "draw")
    _stake(vm, c, "carol", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "1:1", 0, "agree")

    vm.sender = create_address("cron")
    c.resolve()
    info = c.get_match_info()
    assert info["result"] == "draw", info
    assert info["final_score"] == "1:1", info


def test_hyphen_score_is_normalised_to_colon(vm, c):
    # "2-1" is accepted and persisted in the canonical "2:1" form.
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "2-1", 1, "agree")

    vm.sender = create_address("cron")
    c.resolve()
    info = c.get_match_info()
    assert info["result"] == "home", info
    assert info["final_score"] == "2:1", info


def test_spaced_score_is_accepted(vm, c):
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, " 3 : 0 ", 1, "agree")

    vm.sender = create_address("cron")
    c.resolve()
    assert c.get_match_info()["final_score"] == "3:0"


def test_settled_market_cannot_be_resolved_again(vm, c):
    _stake_both_sides(vm, c)
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_sources(vm)
    _mock_verdict(vm, "2:1", 1, "agree")
    vm.sender = create_address("cron")
    c.resolve()
    assert c.get_match_info()["status"] == "resolved"

    _at(vm, KICKOFF_TS + 5 * 3600)
    _mock_verdict(vm, "0:5", 2, "agree")
    vm.sender = create_address("attacker")
    with vm.expect_revert("not open for resolution"):
        c.resolve()
    info = c.get_match_info()
    assert info["result"] == "home", info
    assert info["final_score"] == "2:1", info


# ---- pytest wrappers -----------------------------------------------------

def _make_pytest(fn):
    def _wrapped():
        _run(fn.__name__, fn)
        name, ok, err = _RESULTS[-1]
        assert ok, err
    _wrapped.__name__ = fn.__name__
    return _wrapped


_ALL = [
    # 1. premature resolution
    test_premature_resolution_reverts_before_kickoff,
    test_resolution_allowed_exactly_at_kickoff,
    # 2. missing secondary
    test_missing_secondary_does_not_settle,
    test_secondary_render_failure_does_not_settle,
    test_primary_only_agreement_is_rejected,
    # 3. source conflict
    test_source_conflict_does_not_settle,
    test_conflict_claiming_agree_still_blocked_by_winner_minus_one,
    # 4. invalid winner
    test_invalid_winner_out_of_range_does_not_settle,
    test_invalid_winner_large_does_not_settle,
    test_invalid_winner_string_does_not_settle,
    test_invalid_winner_null_does_not_settle,
    test_invalid_winner_bool_does_not_settle,
    test_invalid_winner_float_does_not_settle,
    # 5. malformed score
    test_malformed_score_empty_does_not_settle,
    test_malformed_score_placeholder_does_not_settle,
    test_malformed_score_ft_does_not_settle,
    test_malformed_score_single_number_does_not_settle,
    test_malformed_score_three_parts_does_not_settle,
    test_malformed_score_words_does_not_settle,
    test_malformed_score_en_dash_does_not_settle,
    test_malformed_score_non_string_does_not_settle,
    # 6. inconsistent score vs winner
    test_inconsistent_home_score_away_winner,
    test_inconsistent_draw_score_home_winner,
    test_inconsistent_away_score_draw_winner,
    # 7. happy path
    test_agreeing_sources_valid_score_settles_after_kickoff,
    test_settles_draw_and_away_correctly,
    test_hyphen_score_is_normalised_to_colon,
    test_spaced_score_is_accepted,
    test_settled_market_cannot_be_resolved_again,
]

for _fn in _ALL:
    globals()["pytest_" + _fn.__name__] = _make_pytest(_fn)


if __name__ == "__main__":
    print("Running resolve() hardening tests for prediction_market.py (UCL '27)\n")
    for _fn in _ALL:
        _run(_fn.__name__, _fn)
    passed = sum(1 for _, ok, _ in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n{passed}/{total} passed")
    if passed != total:
        for name, ok, err in _RESULTS:
            if not ok:
                print(f"  FAIL {name}: {err}")
        raise SystemExit(1)
    print("ALL GREEN")
