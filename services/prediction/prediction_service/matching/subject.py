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
``s``/``es``/``ies`` on tokens long enough that the ``s`` is not the word.

**Two things this fold must not do**, because the descriptor leg is an
identity check that *overrides* the cosine leg (matching/decide.py) -- a
false positive here writes a wrong MATCHED_TREND_ID with no threshold left
to catch it:

* **it must not delete letters it cannot spell in ASCII.** Stripping
  combining marks is the intended win ("açaí" -> "acai"); a letter that does
  not decompose to ASCII is a different matter. Deleting it made
  ``fold("말차 latte")`` and ``fold("抹茶 latte")`` both read ``"latte"``, and
  "søl" and "sæl" both read ``"s l"`` -- distinct subjects declared
  identical. ADR-0003 explicitly frames K-Beauty and this pipeline runs a
  food-drink vertical, so those are reachable strings, and the failure mode
  is a wrong match rather than a miss. Letters survive folding whether or not
  they are ASCII.
* **it must not drop a single letter as a stop word.** ``"a"`` used to be one,
  which made "vitamin a serum" and "vitamin serum" the same subject -- a
  retinol prediction declared identical to a generic vitamin serum. Same
  class: "type a", "plan a". A one-letter token is as often the whole
  distinguishing word as it is an article, and the article case only costs a
  miss.
"""

from __future__ import annotations

import unicodedata

#: Shortest token that may lose a trailing plural ``s``. Below this the ``s``
#: is load-bearing far too often ("gas", "abs", "ms").
_MIN_DEPLURALIZE_LEN = 4

#: Endings that are not plurals, whatever the trailing ``s`` looks like.
#: These are also what makes the fold *symmetric*: "bus"/"buses" and
#: "virus"/"viruses" both settle here, and "hypochlorous" is left alone
#: instead of being mangled to "hypochlorou".
_NON_PLURAL_ENDINGS = ("ss", "us", "is")

#: Tokens carrying no subject identity on their own. Dropped so
#: "the air-dry clay" and "air dry clay" are one subject. Kept tiny on
#: purpose -- every word removed here is a word two different subjects can no
#: longer be told apart by. Note the absence of "a": see the module docstring.
_STOPWORDS = frozenset({"an", "the", "of", "for", "and"})


def fold(text: str) -> str:
    """Lower-case, accent-stripped, punctuation-collapsed form of ``text``.

    Accents are folded because the two sides are authored independently and
    "acai" / "açaí" are the same shopper's word. Letters that do not
    decompose to ASCII are *kept*, not deleted -- see the module docstring.
    """
    decomposed = unicodedata.normalize("NFKD", text.lower())
    kept = "".join(
        ch if ch.isalnum() else " "
        for ch in decomposed
        if not unicodedata.combining(ch)
    )
    return " ".join(kept.split())


def fold_ascii(text: str) -> str:
    """``fold`` narrowed to ASCII, for the SQL window hint only.

    matching/trends.py's DESCRIPTOR_EXACT expression is a coarse ASCII-only
    fold done in SQL, and it exists purely to pull a descriptor-equal trend
    into the candidate window. Handing it a bind that ``fold`` produced would
    compare a string carrying 말차 against one SQL had already stripped to
    empty. The *decision* is never made from this form.
    """
    return " ".join("".join(ch if ch.isascii() else " " for ch in fold(text)).split())


def _plural_fold(token: str) -> str:
    """Strip a plural ending, recursing so the result is a fixed point.

    Recursion is what makes the fold symmetric, and its absence is what the
    first cut got wrong: an ``es`` branch that returned early made "lenses"
    -> "lens" while "lens" -> "len", so the two did not compare equal. Here
    "lenses" -> "lens" -> "len" and "lens" -> "len"; "buses" -> "bus" (which
    the ``us`` guard then leaves alone) and "bus" -> "bus"; "viruses" ->
    "virus" and "virus" -> "virus".
    """
    if len(token) < _MIN_DEPLURALIZE_LEN or not token.endswith("s"):
        return token
    if token.endswith(_NON_PLURAL_ENDINGS):
        return token
    if token.endswith("ies") and len(token) >= _MIN_DEPLURALIZE_LEN + 1:
        # "gummies" -> "gummy", to meet "gummy" coming the other way.
        return _plural_fold(token[:-3] + "y")
    if token.endswith("es") and (token[-3] in "sxz" or token[-4:-2] in ("ch", "sh")):
        return _plural_fold(token[:-2])
    return _plural_fold(token[:-1])


def _depluralize(token: str) -> str:
    """The singular-ish comparison form of one token.

    The output is not always a real English singular -- "lens" and "lenses"
    both land on "len". It is always the *same* string for both members of a
    pair, which is the only property a subject-identity check needs, and the
    property the first cut did not have.

    The second step exists because "-ies" is ambiguous from the plural alone:
    "gummies" is "gummy" + plural, "smoothies" is "smoothie" + plural, and
    the two look identical. Rather than guess, both singulars are pushed to
    the same ending, so "smoothie"/"smoothies" and "gummy"/"gummies" each
    converge whichever way they are written.
    """
    folded = _plural_fold(token)
    if folded.endswith("ie") and len(folded) >= _MIN_DEPLURALIZE_LEN + 1:
        return folded[:-2] + "y"
    return folded


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

    Deterministic and total: no thresholds, no model, no I/O. An empty key is
    never the same subject as anything, including another empty key -- "we
    have no descriptor for this trend" must not read as a match. That covers
    the empty string, a string of punctuation, and a string that is nothing
    but stop words.
    """
    left_key = descriptor_key(left)
    right_key = descriptor_key(right)
    if not left_key or not right_key:
        return False
    return left_key == right_key
