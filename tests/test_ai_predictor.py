# Direct-mode tests for AIPredictor:
#   - admin-only predict()
#   - idempotent per match_id
#   - reset() + set_source() admin gates
#   - LLM output normalization (code fences, team-name answers, casing)
#
# Run:  python tests/test_ai_predictor.py
#   or: python -m pytest tests/test_ai_predictor.py -v
#
# ---------------------------------------------------------------------------
# WHY THIS FILE INSTALLS A gl_call HOOK
#
# gl.eq_principle.prompt_non_comparative does NOT issue a plain `ExecPrompt`
# gl_call the way gl.nondet.exec_prompt does. It issues `ExecPromptTemplate`
# with template="EqNonComparativeLeader" (and "EqNonComparativeValidator" on
# the validator side).
#
# gltest's direct-mode wasi_mock dispatches `ExecPrompt` -> vm.mock_llm(...),
# but has no branch for `ExecPromptTemplate`, so the call falls through to
# `return None`. The contract then receives None from the equivalence
# principle and dies on `raw.strip()`.
#
# That is a harness gap, NOT a contract bug — the same code path works on
# Bradbury. The dispatcher exposes a supported extension point
# (`vm._gl_call_hook`), so we register a hook that answers the template call
# with whatever leader output the individual test wants. vm.mock_llm() is
# therefore NOT used here; _set_leader_output() is the equivalent.
# ---------------------------------------------------------------------------

import os
import sys
import json
import datetime as _dt

from gltest.direct import VMContext, deploy_contract, create_address

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "..", "ai_predictor.py")

STANDINGS = (
    "UEFA Champions League table. 1 Real Madrid 12pts. 2 Manchester City 10pts. "
    "3 Bayern Munich 10pts. 34 Sabah 1pt."
)

_ISO = "2026-09-07T12:00:00Z"


def _at(vm, iso: str = _ISO) -> None:
    """Set BOTH the harness clock and the contract-visible message datetime."""
    vm.warp(iso)
    if "genlayer.gl" in sys.modules:
        sys.modules["genlayer.gl"].message_raw["datetime"] = iso


def _install_hook(vm) -> None:
    """
    Answer the ExecPromptTemplate gl_call that prompt_non_comparative makes.

    The leader's output is read from vm._leader_output at call time, so a test
    can change it between calls. Validators always agree (return True) — the
    validator-side judgement is not what these tests are exercising.
    """
    def hook(_vm, request):
        if "ExecPromptTemplate" not in request:
            return None
        tpl = request["ExecPromptTemplate"].get("template")
        if tpl == "EqNonComparativeLeader":
            return {"ok": getattr(_vm, "_leader_output", "")}
        if tpl == "EqNonComparativeValidator":
            return {"ok": True}
        return None

    vm._gl_call_hook = hook


def _set_leader_output(vm, text: str) -> None:
    """What the leader validator 'returns' from the LLM for the next predict()."""
    vm._leader_output = text


def _deploy(vm):
    vm.sender = create_address("admin")
    _at(vm)
    _install_hook(vm)
    c = deploy_contract(CONTRACT, vm)
    vm.mock_web(r"bbc\.com", {"status": 200, "body": STANDINGS})
    return c


# ---- test harness --------------------------------------------------------

_RESULTS = []


def _run(name, fn):
    vm = VMContext()
    vm.sender = create_address("admin")
    _at(vm)
    _install_hook(vm)
    try:
        with vm.activate():
            _at(vm)
            c = deploy_contract(CONTRACT, vm)
            vm.mock_web(r"bbc\.com", {"status": 200, "body": STANDINGS})
            fn(vm, c)
        _RESULTS.append((name, True, ""))
        print(f"  PASS  {name}")
    except Exception as e:
        _RESULTS.append((name, False, str(e)))
        print(f"  FAIL  {name}: {e}")


# ========================================================================
# HAPPY PATH + STORAGE
# ========================================================================

def test_predict_stores_valid_json(vm, c):
    _set_leader_output(vm, json.dumps({
        "pick": "home",
        "confidence": "high",
        "reason": "Real Madrid are dominant at the Bernabeu.",
    }))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_03", "Real Madrid", "Inter Milan", "2026-09-08")

    got = c.get_prediction("ucl2027_md1_03")
    assert got["has_prediction"] is True, got
    assert got["pick"] == "home", got
    assert got["confidence"] == "high", got
    assert "Bernabeu" in got["reason"], got
    assert got["home"] == "Real Madrid", got
    assert got["away"] == "Inter Milan", got
    assert got["date"] == "2026-09-08", got
    assert c.has_prediction("ucl2027_md1_03") is True


def test_default_source_is_bbc_ucl_table(vm, c):
    src = c.get_source()
    assert src == "https://www.bbc.com/sport/football/champions-league/table", src


def test_has_prediction_false_for_unknown_match(vm, c):
    assert c.has_prediction("ucl2027_md9_99") is False
    assert c.get_prediction("ucl2027_md9_99") == {"has_prediction": False}


# ========================================================================
# ADMIN GATES
# ========================================================================

def test_predict_admin_only(vm, c):
    _set_leader_output(vm, json.dumps({"pick": "home", "confidence": "medium", "reason": "x"}))
    vm.sender = create_address("attacker")
    with vm.expect_revert("admin only"):
        c.predict("ucl2027_md1_07", "Barcelona", "Feyenoord", "2026-09-09")


def test_set_source_admin_only(vm, c):
    vm.sender = create_address("attacker")
    with vm.expect_revert("admin only"):
        c.set_source("https://evil.example/table")
    # unchanged
    assert c.get_source() == "https://www.bbc.com/sport/football/champions-league/table"


def test_set_source_admin_works(vm, c):
    vm.sender = create_address("admin")
    c.set_source("https://www.bbc.com/sport/football/champions-league/table?x=1")
    assert c.get_source().endswith("?x=1")


def test_reset_admin_only(vm, c):
    _set_leader_output(vm, json.dumps({"pick": "draw", "confidence": "low", "reason": "even"}))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_11", "Napoli", "Arsenal", "2026-09-09")
    vm.sender = create_address("attacker")
    with vm.expect_revert("admin only"):
        c.reset("ucl2027_md1_11")


def test_reset_allows_repredict(vm, c):
    _set_leader_output(vm, json.dumps({"pick": "draw", "confidence": "low", "reason": "even"}))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_11", "Napoli", "Arsenal", "2026-09-09")
    assert c.get_prediction("ucl2027_md1_11")["pick"] == "draw"

    c.reset("ucl2027_md1_11")
    assert c.has_prediction("ucl2027_md1_11") is False

    _set_leader_output(vm, json.dumps({"pick": "away", "confidence": "high", "reason": "form"}))
    c.predict("ucl2027_md1_11", "Napoli", "Arsenal", "2026-09-09")
    assert c.get_prediction("ucl2027_md1_11")["pick"] == "away"


def test_reset_unknown_match_reverts(vm, c):
    vm.sender = create_address("admin")
    with vm.expect_revert("no prediction to reset"):
        c.reset("ucl2027_md9_99")


# ========================================================================
# IDEMPOTENCY
# ========================================================================

def test_predict_idempotent(vm, c):
    _set_leader_output(vm, json.dumps({"pick": "draw", "confidence": "medium", "reason": "close"}))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_15", "Bayern Munich", "Bodo/Glimt", "2026-09-10")
    # Second call for the same match_id must revert — the cron relies on this
    # so a re-submit never double-charges the LLM.
    vm.sender = create_address("admin")
    with vm.expect_revert("already has an AI prediction"):
        c.predict("ucl2027_md1_15", "Bayern Munich", "Bodo/Glimt", "2026-09-10")


# ========================================================================
# OUTPUT NORMALIZATION
# ========================================================================

def test_normalizes_code_fenced_json(vm, c):
    _set_leader_output(
        vm,
        "```json\n" + json.dumps({"pick": "AWAY", "confidence": "LOW", "reason": "form"}) + "\n```",
    )
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_01", "AEK Athens", "Barcelona", "2026-09-08")
    got = c.get_prediction("ucl2027_md1_01")
    assert got["pick"] == "away", got
    assert got["confidence"] == "low", got


def test_normalizes_team_name_answer(vm, c):
    # Model answered with the winning team's name instead of home/away.
    _set_leader_output(
        vm,
        json.dumps({"pick": "Bayern Munich", "confidence": "high", "reason": "class gap"}),
    )
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_16", "Bayern Munich", "Sabah", "2026-09-10")
    assert c.get_prediction("ucl2027_md1_16")["pick"] == "home"


def test_normalizes_away_team_name_answer(vm, c):
    _set_leader_output(
        vm,
        json.dumps({"pick": "Manchester City", "confidence": "medium", "reason": "away class"}),
    )
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_04", "Porto", "Manchester City", "2026-09-08")
    assert c.get_prediction("ucl2027_md1_04")["pick"] == "away"


def test_normalizes_numeric_pick(vm, c):
    # "1" = home in classic 1X2 notation.
    _set_leader_output(vm, json.dumps({"pick": "1", "confidence": "high", "reason": "home edge"}))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_09", "Liverpool", "Atletico Madrid", "2026-09-09")
    assert c.get_prediction("ucl2027_md1_09")["pick"] == "home"


def test_normalizes_home_win_phrase(vm, c):
    _set_leader_output(vm, json.dumps({"pick": "home win", "confidence": "high", "reason": "anfield"}))
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_09", "Liverpool", "Atletico Madrid", "2026-09-09")
    assert c.get_prediction("ucl2027_md1_09")["pick"] == "home"


def test_bad_confidence_falls_back_to_medium(vm, c):
    _set_leader_output(
        vm,
        json.dumps({"pick": "home", "confidence": "extremely certain", "reason": "r"}),
    )
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_05", "Borussia Dortmund", "Villarreal", "2026-09-08")
    assert c.get_prediction("ucl2027_md1_05")["confidence"] == "medium"


def test_reason_truncated_to_280(vm, c):
    long_reason = "x" * 500
    _set_leader_output(
        vm,
        json.dumps({"pick": "home", "confidence": "high", "reason": long_reason}),
    )
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_06", "Lille", "Real Betis", "2026-09-08")
    assert len(c.get_prediction("ucl2027_md1_06")["reason"]) == 280


def test_unparseable_output_reverts(vm, c):
    # No JSON, no recoverable keyword, and both team names absent -> revert
    # rather than storing a garbage pick.
    _set_leader_output(vm, "I am unable to answer that question at this time.")
    vm.sender = create_address("admin")
    with vm.expect_revert("could not derive a home/draw/away pick"):
        c.predict("ucl2027_md1_18", "Slavia Prague", "Lens", "2026-09-10")


def test_prose_mentioning_home_team_resolves_to_home(vm, c):
    # DOCUMENTS A DELIBERATE SHARP EDGE (inherited from the La Liga reference).
    #
    # When the output is not JSON, _parse_prediction sets pick_raw to the WHOLE
    # text. _normalize_pick then hits its team-name substring check (step 3)
    # before the ambiguity-guarded full-text scan (step 4) is ever reached — so
    # prose that names BOTH clubs resolves to whichever check fires first, i.e.
    # home. It does NOT revert.
    #
    # This is intentional, not an oversight: routing pick_raw through the full
    # text is exactly what lets a bare "home" or a bare winning-team name parse
    # successfully. Tightening it would break those legitimate cases.
    #
    # Accepted because the blast radius is zero — AIPredictor holds no funds and
    # the pick is a decorative badge next to the crowd's pools. The real defence
    # is upstream: the task demands a single JSON object and
    # prompt_non_comparative's criteria makes validators reject non-JSON output,
    # so prose should not reach this parser under consensus in the first place.
    _set_leader_output(vm, "Either Slavia Prague or Lens could realistically win this one.")
    vm.sender = create_address("admin")
    c.predict("ucl2027_md1_18", "Slavia Prague", "Lens", "2026-09-10")
    got = c.get_prediction("ucl2027_md1_18")
    assert got["pick"] == "home", got
    # Confidence/reason default sanely when nothing structured was supplied.
    assert got["confidence"] == "medium", got


# ---- pytest wrappers -----------------------------------------------------

def _make_pytest(fn):
    def _wrapped():
        _run(fn.__name__, fn)
        name, ok, err = _RESULTS[-1]
        assert ok, err
    _wrapped.__name__ = fn.__name__
    return _wrapped


_ALL = [
    test_predict_stores_valid_json,
    test_default_source_is_bbc_ucl_table,
    test_has_prediction_false_for_unknown_match,
    test_predict_admin_only,
    test_set_source_admin_only,
    test_set_source_admin_works,
    test_reset_admin_only,
    test_reset_allows_repredict,
    test_reset_unknown_match_reverts,
    test_predict_idempotent,
    test_normalizes_code_fenced_json,
    test_normalizes_team_name_answer,
    test_normalizes_away_team_name_answer,
    test_normalizes_numeric_pick,
    test_normalizes_home_win_phrase,
    test_bad_confidence_falls_back_to_medium,
    test_reason_truncated_to_280,
    test_unparseable_output_reverts,
    test_prose_mentioning_home_team_resolves_to_home,
]

for _fn in _ALL:
    globals()["pytest_" + _fn.__name__] = _make_pytest(_fn)


if __name__ == "__main__":
    print("Running direct-mode tests for ai_predictor.py (UCL '27)\n")
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
