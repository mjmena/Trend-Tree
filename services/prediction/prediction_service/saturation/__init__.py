"""Saturation as evidence, plus the pillar's one mechanical gate (CRMA-765).

``EVIDENCE.saturation`` -- Exploding Topics' classification for the subject
descriptor and GDELT's article breadth for the same string -- lands on every
verdict this service writes, matched or white-space alike, and the model's
reasoning addresses it. The strategy's line is the whole design constraint:
"``peaked`` argues against high confidence; nothing is mechanically excluded;
an ET miss carries no penalty."

The data-quality floor ships here too, and it is the only mechanical gate the
strategy permits anywhere in the pillar: no verdict is requested on a subject
whose observation record is too young or too sparse to judge, and a skipped
subject produces no ledger row.

Public surface:

* ``SaturationPhase`` / ``build_saturation_phase`` -- the pass, and the
  deployed wiring of it.
* ``SaturationOracle`` / ``ExplodingTopicsOracle`` / ``StaticSaturationOracle``
  and ``BreadthReader`` / ``GdeltBreadthReader`` / ``StaticBreadthReader`` --
  the two external seams, deployed and offline flavors, neither of which
  raises.
* ``DataQualityFloor`` / ``assess_floor`` -- the gate.
* ``build_saturation_evidence`` / ``attach_saturation`` -- the ledger payload.
* ``build_weighing_system_prompt`` / ``build_weighing_user_prompt`` /
  ``parse_weighings`` -- the weighing turn, as pure functions.
"""

from __future__ import annotations

from .evidence import (
    SATURATION_KEY,
    attach_saturation,
    breadth_evidence,
    build_saturation_evidence,
    et_evidence,
)
from .floor import (
    MIN_EVIDENCE_CHARS,
    MIN_OBSERVATION_AGE_HOURS,
    TOO_SPARSE,
    TOO_YOUNG,
    DataQualityFloor,
    EvidenceRecord,
    FloorAssessment,
    assess_floor,
    build_evidence_record,
)
from .lookup import (
    BREADTH_NOT_CONSULTED,
    CLASSIFICATION_PEAKED,
    ERROR_DEADLINE_EXCEEDED,
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    MISS_NOT_IN_CATALOG,
    ArticleBreadth,
    BreadthReader,
    ExplodingTopicsOracle,
    GdeltBreadthReader,
    SaturationLookup,
    SaturationOracle,
    StaticBreadthReader,
    StaticSaturationOracle,
    load_saturation_fixture,
    normalize_et_response,
    normalize_gdelt_response,
)
from .run import (
    DEFAULT_LOOKUP_BUDGET_S,
    SaturationPhase,
    build_saturation_phase,
    corpus_index,
    floor_from_settings,
)
from .weigh import (
    WEIGHING_MARKER,
    UnparseableWeighing,
    Weighing,
    WeighingItem,
    build_weighing_system_prompt,
    build_weighing_user_prompt,
    parse_weighings,
)

__all__ = [
    "BREADTH_NOT_CONSULTED",
    "CLASSIFICATION_PEAKED",
    "DEFAULT_LOOKUP_BUDGET_S",
    "ERROR_DEADLINE_EXCEEDED",
    "MIN_EVIDENCE_CHARS",
    "MIN_OBSERVATION_AGE_HOURS",
    "MISS_LOOKUP_FAILED",
    "MISS_NOT_CONFIGURED",
    "MISS_NOT_IN_CATALOG",
    "SATURATION_KEY",
    "TOO_SPARSE",
    "TOO_YOUNG",
    "WEIGHING_MARKER",
    "ArticleBreadth",
    "BreadthReader",
    "DataQualityFloor",
    "EvidenceRecord",
    "ExplodingTopicsOracle",
    "FloorAssessment",
    "GdeltBreadthReader",
    "SaturationLookup",
    "SaturationOracle",
    "SaturationPhase",
    "StaticBreadthReader",
    "StaticSaturationOracle",
    "UnparseableWeighing",
    "Weighing",
    "WeighingItem",
    "assess_floor",
    "attach_saturation",
    "breadth_evidence",
    "build_evidence_record",
    "build_saturation_evidence",
    "build_saturation_phase",
    "build_weighing_system_prompt",
    "build_weighing_user_prompt",
    "corpus_index",
    "et_evidence",
    "floor_from_settings",
    "load_saturation_fixture",
    "normalize_et_response",
    "normalize_gdelt_response",
    "parse_weighings",
]
