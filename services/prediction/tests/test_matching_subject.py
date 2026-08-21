"""The descriptor-vocabulary comparison (CRMA-764).

Both sides are authored under ADR-0003's rule -- an atomic,
consumer-vernacular noun -- by two different agents at two different times.
What the comparison has to survive is the incidentals they will disagree on,
and what it must not do is collapse two subjects that a strategist would
call different things.
"""

from __future__ import annotations

import pytest

from prediction_service.matching.subject import descriptor_key, fold, same_subject


@pytest.mark.parametrize(
    ("left", "right"),
    [
        # Hyphenation: the live case. FCT_TRENDS carries "air dry clay"; the
        # generation agent minted "air-dry clay".
        ("air-dry clay", "air dry clay"),
        # Case.
        ("Rucking Vests", "rucking vests"),
        # Number.
        ("rucking vests", "rucking vest"),
        ("UV sensor stickers", "UV sensor sticker"),
        ("sun patches", "sun patch"),
        # Accents -- the two sides are authored independently.
        ("acai bowls", "açaí bowl"),
        # Whitespace and a trailing article.
        ("  the  snail   mucin ", "snail mucin"),
    ],
)
def test_the_same_subject_written_two_ways(left, right):
    assert same_subject(left, right)
    assert same_subject(right, left)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        # The live near-miss the embedding leg also gets wrong: one shared
        # word, two different products.
        ("probiotic nasal spray", "probiotic body spray"),
        ("rucking vests", "weighted vest"),
        ("continuous hormone monitor", "wearable hormone tracker"),
        # Word order carries meaning; a set comparison would lose this.
        ("clay mask", "mask clay"),
        # A superset is not the same subject.
        ("snail mucin", "snail mucin essence"),
    ],
)
def test_different_subjects_stay_different(left, right):
    assert not same_subject(left, right)


def test_a_missing_descriptor_is_never_a_match():
    # A trend with no descriptor must not collide with a prediction whose
    # subject is somehow empty -- "we know nothing about either" is not
    # evidence that they are the same thing.
    assert not same_subject("", "")
    assert not same_subject("   ", "rucking vests")
    assert not same_subject("rucking vests", "")


def test_short_words_keep_their_s():
    # Depluralizing "gas" to "ga" would fold unrelated subjects together.
    assert descriptor_key("gas") == ("gas",)
    assert descriptor_key("abs") == ("abs",)
    assert descriptor_key("glass") == ("glass",)


def test_es_plurals_fold_on_the_shapes_that_take_them():
    assert descriptor_key("patches") == ("patch",)
    assert descriptor_key("brushes") == ("brush",)
    # ...and not on the ones that do not: "vests" loses one s, not two.
    assert descriptor_key("vests") == ("vest",)


def test_fold_is_the_plain_text_form():
    assert fold("Air-Dry Clay!!") == "air dry clay"
    assert fold("  MULTI   space  ") == "multi space"
