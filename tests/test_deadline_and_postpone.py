# Direct-mode tests for the UCL '27 self-settling pari-mutuel contract.
#
# Focus: the fixture-specific betting deadline and the verifiable,
# constrained postponement policy — plus proof that the normal
# resolve/claim path is untouched. Ported from the La Liga reference; only
# the fixture (Real Madrid vs Manchester City, MD1) and prompt keywords
# change — the contract logic is identical.
#
# Run:  python -m pytest tests/ -v      (uses the gltest pytest plugin)
#   or: python tests/test_deadline_and_postpone.py   (standalone, no pytest)
#
# Time model: GenLayer exposes the consensus tx time as an ISO string on
# gl.message_raw["datetime"]. gltest's vm.warp() moves datetime.now(); we
# ALSO set gl.message_raw["datetime"] so the contract's _now_epoch() (which
# reads the message) advances too. Both are set by _at().

import os
import json
import datetime as _dt

from gltest.direct import VMContext, deploy_contract, create_address

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "..", "prediction_market.py")

# Real Madrid vs Manchester City — the marquee 2026/27 MD1 fixture.
# Kickoff 2026-09-08T19:00:00Z (Tue 8 Sep 2026, 19:00 UTC).
KICKOFF_TS = 1789232400
GRACE = 10800  # POSTPONE_GRACE_SECS in the contract (3h)
TWO_GEN = 2_000_000_000_000_000_000


def _iso(epoch: int) -> str:
    return (
        _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)
        + _dt.timedelta(seconds=epoch)
    ).isoformat().replace("+00:00", "Z")


def _at(vm, epoch: int) -> None:
    """Set BOTH the harness clock and the contract-visible message datetime."""
    iso = _iso(epoch)
    vm.warp(iso)
    import sys
    if "genlayer.gl" in sys.modules:
        sys.modules["genlayer.gl"].message_raw["datetime"] = iso


# ---- BBC/ESPN mock pages -------------------------------------------------

def _finished_page() -> str:
    return "Champions League. Real Madrid 2-1 Manchester City. Full time. Match finished."


def _postponed_page() -> str:
    return (
        "Champions League. Real Madrid v Manchester City. POSTPONED. "
        "The fixture has been called off. No score."
    )


def _upcoming_page() -> str:
    return "Champions League. Real Madrid v Manchester City. Kick off 19:00. Not started."


def _abandoned_page() -> str:
    return (
        "Champions League. Real Madrid v Manchester City. ABANDONED. "
        "The match was abandoned after kick-off; no full-time score recorded."
    )


def _fenced(obj) -> str:
    """Wrap JSON in a ```json fence, as real LLMs do. The contract strips the
    fence then json.loads(). Fenced text is not valid JSON, so gltest's LLM
    mock passes it through as a raw string (matching exec_prompt without
    response_format) instead of auto-parsing it to a dict."""
    return "```json\n" + json.dumps(obj) + "\n```"


def _mock_result(vm, winner: int = 1, score: str = "2:1") -> None:
    vm.mock_web(r"bbc\.com", {"status": 200, "body": _finished_page()})
    vm.mock_web(r"espn\.com", {"status": 200, "body": _finished_page()})
    vm.mock_llm(
        r"FULL-TIME score",
        _fenced({"score": score, "winner": winner, "agreement": "agree"}),
    )


def _mock_postponed_sources(vm, status: str = "postponed") -> None:
    """Back-compat shim: BOTH sources behave identically."""
    if status == "postponed":
        page = _postponed_page()
        out = {
            "primary_status": "postponed",
            "secondary_status": "postponed",
            "primary_explicit": True,
        }
    elif status == "finished":
        page = _finished_page()
        out = {
            "primary_status": "finished",
            "secondary_status": "finished",
            "primary_explicit": False,
        }
    else:  # "unknown"
        page = _upcoming_page()
        out = {
            "primary_status": "unknown",
            "secondary_status": "unknown",
            "primary_explicit": False,
        }
    vm.mock_web(r"bbc\.com", {"status": 200, "body": page})
    vm.mock_web(r"espn\.com", {"status": 200, "body": page})
    vm.mock_llm(r"POSTPONED", _fenced(out))


def _mock_postpone_verdict(
    vm,
    primary_status: str,
    secondary_status: str,
    primary_explicit: bool,
    primary_page: str = None,
    secondary_page: str = None,
) -> None:
    """Fine-grained control for conflict / missing-secondary tests."""
    vm.mock_web(
        r"bbc\.com",
        {"status": 200, "body": primary_page if primary_page is not None else _postponed_page()},
    )
    if secondary_page is not None:
        vm.mock_web(r"espn\.com", {"status": 200, "body": secondary_page})
    vm.mock_llm(
        r"POSTPONED",
        _fenced({
            "primary_status": primary_status,
            "secondary_status": secondary_status,
            "primary_explicit": primary_explicit,
        }),
    )


# ---- test harness --------------------------------------------------------

_RESULTS = []


def _run(name, fn):
    vm = VMContext()
    vm.sender = create_address("deployer")
    _at(vm, KICKOFF_TS - 7 * 24 * 3600)  # deploy a week before kickoff
    try:
        with vm.activate():
            c = deploy_contract(CONTRACT, vm, "Real Madrid", "Manchester City",
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


# ========================================================================
# BETTING DEADLINE / IRREVERSIBLE CLOSE
# ========================================================================

def test_bet_before_kickoff_ok(vm, c):
    _at(vm, KICKOFF_TS - 3600)  # 1h before
    _stake(vm, c, "alice", "home")
    info = c.get_my_prediction(create_address("alice"))
    assert info["has_predicted"] is True, info
    assert int(c.get_pools()["home"]) == TWO_GEN


def test_bet_one_second_before_kickoff_ok(vm, c):
    _at(vm, KICKOFF_TS - 1)
    _stake(vm, c, "alice", "draw")
    assert int(c.get_pools()["draw"]) == TWO_GEN


def test_bet_at_exact_kickoff_reverts(vm, c):
    _at(vm, KICKOFF_TS)
    vm.sender = create_address("late")
    vm.value = TWO_GEN
    with vm.expect_revert("betting closed"):
        c.submit_prediction("home")
    vm.value = 0


def test_bet_after_kickoff_reverts(vm, c):
    _at(vm, KICKOFF_TS + 60 * 45)  # 45' into the match
    vm.sender = create_address("late")
    vm.value = TWO_GEN
    with vm.expect_revert("betting closed"):
        c.submit_prediction("away")
    vm.value = 0


def test_bet_after_result_known_reverts(vm, c):
    _at(vm, KICKOFF_TS + 3 * 3600)
    vm.sender = create_address("sharp")
    vm.value = TWO_GEN
    with vm.expect_revert("betting closed"):
        c.submit_prediction("home")
    vm.value = 0


def test_deadline_is_irreversible_after_resolve(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=1)
    vm.sender = create_address("anyone")
    c.resolve()
    assert c.get_match_info()["status"] == "resolved"
    _at(vm, KICKOFF_TS - 3600)
    vm.sender = create_address("cheater")
    vm.value = TWO_GEN
    with vm.expect_revert("predictions closed"):
        c.submit_prediction("home")
    vm.value = 0


def test_min_stake_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    vm.sender = create_address("cheap")
    vm.value = TWO_GEN - 1
    with vm.expect_revert("minimum stake"):
        c.submit_prediction("home")
    vm.value = 0


def test_bad_pick_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    vm.sender = create_address("typo")
    vm.value = TWO_GEN
    with vm.expect_revert("pick must be"):
        c.submit_prediction("winner")
    vm.value = 0


def test_double_pick_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    vm.sender = create_address("alice")
    vm.value = TWO_GEN
    with vm.expect_revert("already predicted"):
        c.submit_prediction("away")
    vm.value = 0


# ========================================================================
# RESOLVE — winner mapping + unresolved path
# ========================================================================

def test_resolve_stays_open_when_unresolved(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + 2 * 3600)
    vm.mock_web(r"bbc\.com", {"status": 200, "body": _upcoming_page()})
    vm.mock_web(r"espn\.com", {"status": 200, "body": _upcoming_page()})
    vm.mock_llm(
        r"FULL-TIME score",
        _fenced({"score": "-", "winner": -1, "agreement": "primary-only"}),
    )
    vm.sender = create_address("anyone")
    c.resolve()
    assert c.get_match_info()["status"] == "open"


def test_resolve_home_win(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=1)
    c.resolve()
    info = c.get_match_info()
    assert info["result"] == "home"


def test_resolve_away_win(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=2, score="0:2")
    c.resolve()
    assert c.get_match_info()["result"] == "away"


def test_resolve_draw(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "draw")
    _stake(vm, c, "carol", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=0, score="1:1")
    c.resolve()
    assert c.get_match_info()["result"] == "draw"


# ========================================================================
# HAPPY PATH: resolve → claim pays winner
# ========================================================================

def test_resolve_and_claim_pays_winner(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")   # winner
    _stake(vm, c, "bob", "away")     # loser
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=1, score="2:1")
    vm.sender = create_address("cron")
    c.resolve()
    info = c.get_match_info()
    assert info["status"] == "resolved", info
    assert info["result"] == "home", info
    assert info["final_score"] == "2:1", info
    vm.deal(vm._contract_address, 2 * TWO_GEN)
    vm.sender = create_address("alice")
    c.claim()
    assert c.get_my_prediction(create_address("alice"))["claimed"] is True


# ========================================================================
# REFUND PATH: winning pool empty OR total = winning pool
# ========================================================================

def test_refund_when_no_winning_pool(vm, c):
    # Everyone bet home; result is away → refund path.
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "home")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=2, score="0:1")
    c.resolve()
    assert c.get_match_info()["status"] == "refunding"


def test_refund_when_everyone_right(vm, c):
    # Everyone bet home; result is home → 100% winning → refund path (Option X).
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "home")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=1, score="2:0")
    c.resolve()
    assert c.get_match_info()["status"] == "refunding"


# ========================================================================
# POSTPONEMENT: VERIFIABLE + CONSTRAINED
# ========================================================================

def test_postpone_too_early_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE - 1)
    _mock_postponed_sources(vm, "postponed")
    vm.sender = create_address("anyone")
    with vm.expect_revert("too early"):
        c.mark_postponed()


def test_postpone_confirmed_opens_refunds(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postponed_sources(vm, "postponed")
    vm.sender = create_address("anyone")
    c.mark_postponed()
    assert c.get_match_info()["status"] == "refunding"
    vm.deal(vm._contract_address, 2 * TWO_GEN)
    vm.sender = create_address("alice")
    c.refund()
    assert c.get_my_prediction(create_address("alice"))["claimed"] is True


def test_postpone_when_actually_finished_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postponed_sources(vm, "finished")
    vm.sender = create_address("loser")
    with vm.expect_revert("finished result"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


def test_postpone_unknown_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postponed_sources(vm, "unknown")
    vm.sender = create_address("anyone")
    with vm.expect_revert("does not confirm postponement"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


def test_refund_blocked_until_contract_reports_refunding(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")

    _at(vm, KICKOFF_TS + GRACE + 60)
    vm.sender = create_address("alice")
    with vm.expect_revert("refunds not available"):
        c.refund()
    assert c.get_match_info()["status"] == "open"

    _mock_postponed_sources(vm, "postponed")
    vm.sender = create_address("anyone")
    c.mark_postponed()
    assert c.get_match_info()["status"] == "refunding"

    vm.deal(vm._contract_address, 2 * TWO_GEN)
    vm.sender = create_address("alice")
    c.refund()
    assert c.get_my_prediction(create_address("alice"))["claimed"] is True


def test_postpone_cannot_unwind_resolved(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + 2 * 3600)
    _mock_result(vm, winner=1)
    vm.sender = create_address("cron")
    c.resolve()
    assert c.get_match_info()["status"] == "resolved"
    _at(vm, KICKOFF_TS + 5 * 3600)
    _mock_postponed_sources(vm, "postponed")
    vm.sender = create_address("loser")
    with vm.expect_revert("still open"):
        c.mark_postponed()


def test_postpone_abandoned_after_play_opens_refunds(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + GRACE + 3600)
    _mock_postpone_verdict(
        vm,
        primary_status="postponed",
        secondary_status="postponed",
        primary_explicit=True,
        primary_page=_abandoned_page(),
        secondary_page=_abandoned_page(),
    )
    vm.sender = create_address("anyone")
    c.mark_postponed()
    assert c.get_match_info()["status"] == "refunding"


def test_postpone_conflict_primary_postponed_secondary_finished_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postpone_verdict(
        vm,
        primary_status="postponed",
        secondary_status="finished",
        primary_explicit=True,
        primary_page=_postponed_page(),
        secondary_page=_finished_page(),
    )
    vm.sender = create_address("loser")
    with vm.expect_revert("finished result"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


def test_postpone_conflict_primary_finished_secondary_postponed_reverts(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postpone_verdict(
        vm,
        primary_status="finished",
        secondary_status="postponed",
        primary_explicit=False,
        primary_page=_finished_page(),
        secondary_page=_postponed_page(),
    )
    vm.sender = create_address("loser")
    with vm.expect_revert("finished result"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


def test_postpone_missing_secondary_explicit_primary_opens_refunds(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _stake(vm, c, "bob", "away")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postpone_verdict(
        vm,
        primary_status="postponed",
        secondary_status="unavailable",
        primary_explicit=True,
        primary_page=_postponed_page(),
        secondary_page="",
    )
    vm.sender = create_address("anyone")
    c.mark_postponed()
    assert c.get_match_info()["status"] == "refunding"


def test_postpone_missing_secondary_not_explicit_stays_open(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postpone_verdict(
        vm,
        primary_status="postponed",
        secondary_status="unavailable",
        primary_explicit=False,
        primary_page=_postponed_page(),
        secondary_page="",
    )
    vm.sender = create_address("anyone")
    with vm.expect_revert("primary not explicit"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


def test_postpone_secondary_unknown_stays_open(vm, c):
    _at(vm, KICKOFF_TS - 3600)
    _stake(vm, c, "alice", "home")
    _at(vm, KICKOFF_TS + GRACE + 60)
    _mock_postpone_verdict(
        vm,
        primary_status="postponed",
        secondary_status="unknown",
        primary_explicit=True,
        primary_page=_postponed_page(),
        secondary_page=_upcoming_page(),
    )
    vm.sender = create_address("anyone")
    with vm.expect_revert("secondary source does not confirm"):
        c.mark_postponed()
    assert c.get_match_info()["status"] == "open"


# ---- pytest wrappers -----------------------------------------------------

def _make_pytest(fn):
    def _wrapped():
        def inner(vm, c):
            fn(vm, c)
        _run(fn.__name__, inner)
        name, ok, err = _RESULTS[-1]
        assert ok, err
    _wrapped.__name__ = fn.__name__
    return _wrapped


_ALL = [
    test_bet_before_kickoff_ok,
    test_bet_one_second_before_kickoff_ok,
    test_bet_at_exact_kickoff_reverts,
    test_bet_after_kickoff_reverts,
    test_bet_after_result_known_reverts,
    test_deadline_is_irreversible_after_resolve,
    test_min_stake_reverts,
    test_bad_pick_reverts,
    test_double_pick_reverts,
    test_resolve_stays_open_when_unresolved,
    test_resolve_home_win,
    test_resolve_away_win,
    test_resolve_draw,
    test_resolve_and_claim_pays_winner,
    test_refund_when_no_winning_pool,
    test_refund_when_everyone_right,
    test_postpone_too_early_reverts,
    test_postpone_confirmed_opens_refunds,
    test_postpone_when_actually_finished_reverts,
    test_postpone_unknown_reverts,
    test_refund_blocked_until_contract_reports_refunding,
    test_postpone_cannot_unwind_resolved,
    test_postpone_abandoned_after_play_opens_refunds,
    test_postpone_conflict_primary_postponed_secondary_finished_reverts,
    test_postpone_conflict_primary_finished_secondary_postponed_reverts,
    test_postpone_missing_secondary_explicit_primary_opens_refunds,
    test_postpone_missing_secondary_not_explicit_stays_open,
    test_postpone_secondary_unknown_stays_open,
]

for _fn in _ALL:
    globals()["pytest_" + _fn.__name__] = _make_pytest(_fn)


if __name__ == "__main__":
    print("Running direct-mode tests for prediction_market.py (UCL '27)\n")
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
