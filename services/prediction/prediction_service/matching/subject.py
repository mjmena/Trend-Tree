"""Comparing two strings written in the descriptor vocabulary (CRMA-764).

ADR-0003 fixes what both sides of the comparison are: a trend's
``descriptor.query`` is "a single atomic, consumer-vernacular noun
(ingredient / product / practice a shopper would search)", and a prediction's
``SUBJECT_DESCRIPTOR`` is minted under the same rule (domain/claim.py). They
are written by two different agents at two different times, so they agree on
the *word* and disagree on the incidentals: hyphenation ("air-dry clay" vs
"air dry clay"), case, and number ("weighted vest" vs "weighted vests").

This module owns that comparison and nothing else -- pure, no I/O, no
warehouse. The SQL side (matching/trends.py) does a coarser, ASCII-only
version of the same fold purely to guarantee a descriptor-equal trend is
inside the candidate window; the decision is always made here.

Deliberately *not* a stemmer. A real stemmer would fold "clay" and "claying",
which is more collapsing than a subject-identity check should do, and it
would put a dependency between two agents' vocabularies and a third party's
linguistic model. The rule is: fold punctuation, fold case, fold a plural
``s``/``es`` on tokens long enough that the ``s`` is not the word.
"""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^0-9a-z]+")

#: Shortest token that may lose a trailing plural ``s``. Below this the ``s``
#: is load-bearing far too often ("gas", "abs", "ms").
_MIN_DEPLURALIZE_LEN = 4

#: Tokens carrying no subject identity on their own. Dropped so
#: "the air-dry clay" and "air dry clay" are one subject. Kept tiny on
#: purpose -- every word removed here is a word two different subjects can no
#: longer be told apart by.
_STOPWORDS = frozenset({"a", "an", "the", "of", "for", "and"})


def fold(text: str) -> str:
    """Lower-case, accent-stripped, punctuation-collapsed form of ``text``.

    Accents are folded because the two sides are authored independently and
    "acai" / "açaí" are the same shopper's word.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(_NON_ALNUM.sub(" ", ascii_only.lower()).split())


def _depluralize(token: str) -> str:
    if len(token) >= _MIN_DEPLURALIZE_LEN + 1 and token.endswith("es"):
        # "patches" -> "patch", but "vests" -> "vest" via the `s` branch.
        if token[-3] in "sxz" or token[-4:-2] in ("ch", "sh"):
            return token[:-2]
    if len(token) >= _MIN_DEPLURALIZE_LEN and token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    return token


def descriptor_key(text: str) -> tuple[str, ...]:
    """The comparison form of a descriptor-vocabulary string: folded,
    stop-worded, singularised tokens, **in order**.

    Order is kept. "clay mask" and "mask clay" are not the same subject, and a
    set comparison would say they were.
    """
    return tuple(
        _depluralize(token) for token in fold(text).split() if token not in _STOPWORDS
    )


def same_subject(left: str, right: str) -> bool:
    """Whether two descriptor-vocabulary strings name the same subject.

    Deterministic and total: no thresholds, no model, no I/O. An empty string
    is never the same subject as anything, including another empty string --
    "we have no descriptor for this trend" must not read as a match.
    """
    left_key = descriptor_key(left)
    if not left_key:
        return False
    return left_key == descriptor_key(right)
