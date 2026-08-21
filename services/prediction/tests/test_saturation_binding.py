"""A restatement is bound to the call it names, at the ledger (CRMA-765).

The saturation weighing pass is the only way saturation is allowed to move a
verdict, so *which* verdict a restatement lands on is a data-correctness
property, not a parsing detail. It used to be decided by the echoed subject
descriptor -- and SUBJECT_DESCRIPTOR is not unique. ``generation/run.py``
dedupes candidates on ``eval_id_for(chain, claim)``, the whole four-part
claim, and ``generation/parse.py`` enforces no subject uniqueness, so one
generation reply can legitimately mint two candidates that share a subject
and differ in their directional claim. A reply that returned those two
entries swapped or renumbered would then write each call with the other's
confidence and the other's reasoning: every row still written, nothing
dropped, nothing detectably wrong downstream.

The same bug, found and fixed first in the re-evaluation sweep (CRMA-766,
sweep/parse.py), where it was worse -- a mis-bound ``met`` closes the wrong
prediction permanently. The fix is the sweep's: bind on the prediction's own
identity, require the echoed identity and the position to agree, check the
subject as a second opinion, and DROP an internally inconsistent entry rather
than reconcile it.

Everything here is asserted on the rows POST /generate wrote, because that is
where the mislabelling would have been permanent and invisible. And every
case holds the pillar's invariant: a dropped restatement means "keep
generation's own confidence and reasoning" -- never a rejection. The
data-quality floor is still the only mechanical gate.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.generation.llm import DEFAULT_MODEL, LLMResponse, estimate_cost_usd
from prediction_service.saturation import (
    ArticleBreadth,
    DataQualityFloor,
    SaturationLookup,
    SaturationPhase,
    StaticBreadthReader,
    StaticSaturationOracle,
)

from .fakes import FakeSnowflake, is_weighing_turn

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}

RICH = (
    "Adjustable weighted vests in the 12-20 lb range hold four consecutive weeks on the "
    "category movers list; the leading listings are specialty fitness brands rather than "
    "the mass-market house labels that dominate the rest of the category."
)


def _at(hours_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours_ago)).strftime("%Y-%m-%d %H:%M:%S.%f")


def _row(signal_id: str, *, hours_ago: float = 96) -> dict:
    return {
        "SIGNAL_ID": signal_id,
        "SOURCE_NAME": "amazon_trends",
        "SIGNAL_TIMESTAMP": _at(hours_ago),
        "SIGNAL_TITLE": "weighted vests hold the movers list",
        "SIGNAL_TEXT": RICH,
    }


SETTLED_CORPUS = [_row("s1"), _row("s2", hours_ago=120), _row("s3", hours_ago=72)]

RETAIL = "mass-market retail adoption expands beyond specialty"
PROGRAMMING = "gym class programming adopts them as a standing format"

#: Two candidates, ONE subject. Legitimate: generation dedupes on the whole
#: four-part claim, so these are two different calls about rucking vests and
#: both mint. This is the shape the subject binding could not tell apart.
SAME_SUBJECT_REPLY = json.dumps(
    {
        "predictions": [
            {
                "subject_descriptor": "rucking vests",
                "directional_claim": RETAIL,
                "horizon_band": "emerging_3_6mo",
                "observable_check": "Target lists a house-label weighted vest under 20 lb",
                "confidence": 68,
                "reasoning": "four independent signals converge on the retail shift",
                "source_signals": ["s1", "s2"],
            },
            {
                "subject_descriptor": "rucking vests",
                "directional_claim": PROGRAMMING,
                "horizon_band": "cultural_shift_6_12mo",
                "observable_check": "a top-10 US gym chain lists a rucking class on its schedule",
                "confidence": 54,
                "reasoning": "studio schedules are the slower half of the same shift",
                "source_signals": ["s3"],
            },
        ]
    }
)

CHEESE = "displaces ricotta as the default soft cheese"

#: The distinct-subject batch, for the renumbering case.
TWO_SUBJECT_REPLY = json.dumps(
    {
        "predictions": [
            {
                "subject_descriptor": "rucking vests",
                "directional_claim": RETAIL,
                "horizon_band": "emerging_3_6mo",
                "observable_check": "Target lists a house-label weighted vest under 20 lb",
                "confidence": 68,
                "reasoning": "four independent signals converge on the retail shift",
                "source_signals": ["s1", "s2"],
            },
            {
                "subject_descriptor": "cottage cheese",
                "directional_claim": CHEESE,
                "horizon_band": "cultural_shift_6_12mo",
                "observable_check": "Good & Gather lists a 4% milkfat tub in its catalog",
                "confidence": 54,
                "reasoning": "a supply-side change plus an inverted diet framing",
                "source_signals": ["s3"],
            },
        ]
    }
)

PEAKED = SaturationLookup(
    query="rucking vests",
    matched=True,
    classification="peaked",
    classifications={"3": "peaked", "12": "peaked"},
    keyword="rucking vest",
    absolute_volume=40500,
    total=3,
)
BROAD = ArticleBreadth(
    query="rucking vests",
    available=True,
    article_count=44,
    distinct_domains=19,
    top_domains=("nytimes.com",),
)

#: ``  [1] prediction_id: <uuid>`` in the weighing user prompt.
_ID_LINE = re.compile(r"^\s*\[(\d+)\] prediction_id: (\S+)$", re.MULTILINE)


def ids_in_prompt(user: str) -> list[str]:
    """The PREDICTION_IDs the weighing turn was shown, in the order it was
    shown them."""
    return [pid for _, pid in sorted(_ID_LINE.findall(user), key=lambda m: int(m[0]))]


@dataclass
class PromptReadingLLM:
    """A model that answers the weighing turn by READING the prompt.

    The real one does the same, and it is the only way a reply can echo a
    PREDICTION_ID: the ids are minted (uuid4) on the very generation pass
    being weighed, so no canned string could contain one.
    """

    generation_reply: str
    #: Given the PREDICTION_IDs in prompt order, the weighing reply to send.
    weigh: Callable[[list[str]], str]
    model: str = "fake-model"
    input_tokens: int = 1200
    output_tokens: int = 300
    calls: list[tuple[str, str]] = field(default_factory=list)

    def complete(self, *, system: str, user: str) -> LLMResponse:
        self.calls.append((system, user))
        text = self.weigh(ids_in_prompt(user)) if is_weighing_turn(system) else (
            self.generation_reply
        )
        return LLMResponse(
            text=text,
            model=self.model,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            cost_usd=estimate_cost_usd(self.input_tokens, self.output_tokens, model=DEFAULT_MODEL),
        )


def _verify_ok(token: str, audience: str) -> dict:
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "https://accounts.google.com",
    }


def _phase() -> SaturationPhase:
    return SaturationPhase(
        oracle=StaticSaturationOracle(lookups={"rucking vests": PEAKED, "cottage cheese": PEAKED}),
        breadth=StaticBreadthReader(readings={"rucking vests": BROAD, "cottage cheese": BROAD}),
        floor=DataQualityFloor(),
    )


def _fire(weigh, *, reply: str = SAME_SUBJECT_REPLY) -> tuple[list[dict], dict]:
    """POST /generate with a weighing turn answered by ``weigh(ids)``.
    Returns the rows that were MERGEd and the response body."""
    snowflake = FakeSnowflake(rows=list(SETTLED_CORPUS))
    llm = PromptReadingLLM(generation_reply=reply, weigh=weigh)
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    client = TestClient(
        create_app(
            settings=settings,
            snowflake=snowflake,
            verify_token=_verify_ok,
            llm=llm,
            saturation=_phase(),
        )
    )
    body = client.post("/generate", json={}, headers=AUTH_HEADERS).json()
    writes = [dict(call.params) for call in snowflake.calls if call.kind == "execute"]
    # The binding cannot work unless the turn was actually SHOWN the ids it is
    # asked to echo -- a prompt that omitted them would make every entry
    # unbindable and every assertion below pass for the wrong reason.
    weighed = [user for system, user in llm.calls if is_weighing_turn(system)]
    assert weighed, "the weighing turn never ran"
    assert len(ids_in_prompt(weighed[-1])) == body["predictions_written"]
    return writes, body


def _by_claim(writes: list[dict]) -> dict[str, dict]:
    return {w["directional_claim"]: w for w in writes}


def _canned(text: str) -> Callable[[list[str]], str]:
    return lambda _ids: text


def _entry(index: int, prediction_id: str | None, *, confidence: float, reasoning: str) -> dict:
    entry = {
        "id": index,
        "subject": "rucking vests",
        "confidence": confidence,
        "reasoning": reasoning,
    }
    if prediction_id is not None:
        entry["prediction_id"] = prediction_id
    return entry


def _weighings(*entries: dict) -> str:
    return json.dumps({"weighings": list(entries)})


# --- two calls, one subject ------------------------------------------------


def test_two_calls_on_the_same_subject_both_land():
    # The premise. If generation could not mint these, the bug below would be
    # unreachable -- so this is asserted before anything about the binding.
    writes, body = _fire(_canned('{"weighings": []}'))

    assert body["predictions_written"] == 2
    assert set(_by_claim(writes)) == {RETAIL, PROGRAMMING}
    assert len({w["prediction_id"] for w in writes}) == 2
    assert {w["subject_descriptor"] for w in writes} == {"rucking vests"}


def test_a_swapped_same_subject_reply_never_binds_to_the_wrong_call():
    # The bug, at the seam where it would have been permanent. Both entries
    # echo the subject they were shown -- it is the same string for both
    # calls -- and each carries the OTHER call's number and case. Bound by
    # subject, both would have bound, and each row would have been written
    # with the other's confidence and a reasoning paragraph arguing the
    # other's claim.
    def swapped(ids: list[str]) -> str:
        return _weighings(
            _entry(1, ids[1], confidence=95, reasoning="the case for the gym-programming call"),
            _entry(2, ids[0], confidence=12, reasoning="the case for the retail call"),
        )

    writes, body = _fire(swapped)

    rows = _by_claim(writes)
    # Neither entry binds, so both calls keep generation's own number and its
    # own reasoning. A drop is not a gate: both rows still land.
    assert body["predictions_written"] == 2
    assert rows[RETAIL]["confidence"] == 68.0
    assert rows[PROGRAMMING]["confidence"] == 54.0
    assert "gym-programming" not in rows[RETAIL]["reasoning"]
    assert "retail call" not in rows[PROGRAMMING]["reasoning"]
    assert body["rejections"] == []


def test_a_same_subject_reply_that_omits_the_identity_binds_to_neither():
    # The echo the old prompt asked for, on a batch where it decides nothing:
    # both entries name "rucking vests" and both calls answer to it. Position
    # is not evidence of which is which, so neither binds and both rows keep
    # what generation gave them.
    ambiguous = _weighings(
        _entry(1, None, confidence=95, reasoning="but which rucking vests call is this"),
        _entry(2, None, confidence=12, reasoning="and which is this"),
    )

    writes, body = _fire(_canned(ambiguous))

    rows = _by_claim(writes)
    assert body["predictions_written"] == 2
    assert (rows[RETAIL]["confidence"], rows[PROGRAMMING]["confidence"]) == (68.0, 54.0)
    assert body["rejections"] == []


def test_two_same_subject_calls_are_each_weighed_when_the_reply_echoes_its_id():
    # And the guard is not "a shared subject means nothing is ever weighed":
    # echo the right id in the right place and each call gets its own number
    # and its own reasoning, carried across verbatim.
    def straight(ids: list[str]) -> str:
        return _weighings(
            _entry(1, ids[0], confidence=57.5, reasoning="peaked, so the retail runway is short"),
            _entry(2, ids[1], confidence=61, reasoning="programming lags retail, so more room"),
        )

    writes, body = _fire(straight)

    rows = _by_claim(writes)
    assert body["predictions_written"] == 2
    assert rows[RETAIL]["confidence"] == 57.5
    assert "retail runway" in rows[RETAIL]["reasoning"]
    assert rows[PROGRAMMING]["confidence"] == 61.0
    assert "programming lags retail" in rows[PROGRAMMING]["reasoning"]


def test_an_entry_whose_echoed_id_and_position_disagree_is_dropped():
    # Internally inconsistent: entry 2 echoes the id shown for entry 1. Which
    # of the two fields to believe is not the parser's to decide, so it
    # believes neither -- and that call keeps its own number.
    def inconsistent(ids: list[str]) -> str:
        return _weighings(
            _entry(1, ids[0], confidence=57.5, reasoning="coherent, and it binds"),
            _entry(2, ids[0], confidence=99, reasoning="the wrong call's id under this number"),
        )

    writes, body = _fire(inconsistent)

    rows = _by_claim(writes)
    assert rows[RETAIL]["confidence"] == 57.5
    assert rows[PROGRAMMING]["confidence"] == 54.0
    assert "wrong call" not in rows[PROGRAMMING]["reasoning"]
    assert body["rejections"] == []


# --- the renumbering case, on distinct subjects ----------------------------


def test_a_renumbered_reply_binds_by_identity_not_by_position():
    # Ordinary model behaviour when asked to restate a list: re-sort by the
    # new confidence and renumber 1..n. The entries are internally correct --
    # each carries its own call's id, subject and case -- but they no longer
    # sit where their ids say they belong, so neither binds and both rows
    # keep generation's numbers.
    def renumbered(ids: list[str]) -> str:
        return json.dumps(
            {
                "weighings": [
                    {
                        "id": 1,
                        "prediction_id": ids[1],
                        "subject": "cottage cheese",
                        "confidence": 91,
                        "reasoning": "cottage cheese is exploding and I am surer of it",
                    },
                    {
                        "id": 2,
                        "prediction_id": ids[0],
                        "subject": "rucking vests",
                        "confidence": 12,
                        "reasoning": "rucking vests has peaked and I have lost faith",
                    },
                ]
            }
        )

    writes, body = _fire(renumbered, reply=TWO_SUBJECT_REPLY)

    rows = _by_claim(writes)
    assert body["predictions_written"] == 2
    assert rows[RETAIL]["confidence"] == 68.0
    assert rows[CHEESE]["confidence"] == 54.0
    assert "cottage cheese" not in rows[RETAIL]["reasoning"]
    assert "rucking vests" not in rows[CHEESE]["reasoning"]


def test_an_entry_naming_no_call_at_all_is_dropped():
    # No prediction_id and no subject: nothing in it says which call it is
    # about, and its position does not say either.
    nameless = json.dumps(
        {"weighings": [{"id": 1, "confidence": 91, "reasoning": "which call is this about?"}]}
    )

    writes, body = _fire(_canned(nameless), reply=TWO_SUBJECT_REPLY)

    rows = _by_claim(writes)
    assert rows[RETAIL]["confidence"] == 68.0
    assert "which call" not in rows[RETAIL]["reasoning"]
    assert body["predictions_written"] == 2


def test_an_unambiguous_subject_still_binds_without_an_id():
    # The one place this parser is looser than the sweep's, and it is not a
    # correctness gap: with distinct subjects in the batch, the subject picks
    # the call out exactly as well as the id would. It has to hold -- a
    # PREDICTION_ID is minted on the pass being weighed, so a RECORDED reply
    # (the offline loop's fixture, an operator replaying a captured turn)
    # could never echo one, and the pass would be unexercisable offline.
    subject_only = json.dumps(
        {
            "weighings": [
                {
                    "id": 1,
                    "subject": "rucking vests",
                    "confidence": 57.5,
                    "reasoning": "peaked, so the retail runway is shorter than it looked",
                }
            ]
        }
    )

    writes, body = _fire(_canned(subject_only), reply=TWO_SUBJECT_REPLY)

    rows = _by_claim(writes)
    assert rows[RETAIL]["confidence"] == 57.5
    assert rows[CHEESE]["confidence"] == 54.0
    assert body["predictions_written"] == 2


# --- the invariant the binding must not break ------------------------------


def test_no_unbound_restatement_ever_becomes_a_rejection():
    # The CRMA-765 invariant, restated against the worst reply the binding can
    # see: the data-quality floor is the ONLY mechanical gate, and an entry
    # that binds to nothing means "keep generation's own confidence and
    # reasoning" -- never a dropped, capped or discounted call.
    def hostile(ids: list[str]) -> str:
        return _weighings(
            _entry(1, "not-an-id-at-all", confidence=1, reasoning="mislabelled"),
            _entry(2, ids[0], confidence=2, reasoning="the other call's id"),
        )

    writes, body = _fire(hostile)

    assert body["predictions_written"] == 2
    assert body["rejections"] == []
    assert {w["confidence"] for w in writes} == {68.0, 54.0}
    joined = " ".join(r["reason"] for r in body["rejections"]).lower()
    for word in ("bind", "prediction_id", "subject", "weighing", "saturation"):
        assert word not in joined
    # And the run still recorded a weighing pass that happened, with the
    # evidence it gathered -- unbound is not unweighed.
    saturation = json.loads(writes[0]["evidence"])["saturation"]
    assert saturation["weighing"]["weighed"] is True
    assert saturation["exploding_topics"]["classification"] == "peaked"
    assert "unadjusted" in saturation["weighing"]["note"]
