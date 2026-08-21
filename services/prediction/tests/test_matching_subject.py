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


# --- what the fold must not collapse ---------------------------------------


def test_a_single_letter_is_part_of_the_subject_not_an_article():
    # "a" was a stop word, which made a vitamin-A/retinol prediction identical
    # to a generic vitamin serum. The descriptor leg overrides the cosine leg
    # outright, so that is a wrong MATCHED_TREND_ID with nothing left to catch
    # it.
    assert descriptor_key("vitamin a serum") == ("vitamin", "a", "serum")
    assert not same_subject("vitamin a serum", "vitamin serum")
    assert not same_subject("vitamin a", "vitamin")
    # Same class.
    assert not same_subject("type a personality mug", "type personality mug")
    assert not same_subject("plan a", "plan")


@pytest.mark.parametrize(
    ("left", "right"),
    [
        # Two different words for matcha, in two different scripts. Folding
        # used to delete both, leaving each as ("latte",).
        ("말차 latte", "抹茶 latte"),
        # Letters that do not decompose to ASCII are letters, not noise.
        ("søl", "sæl"),
        ("mørk chokolade", "mark chokolade"),
    ],
)
def test_non_ascii_letters_survive_the_fold(left, right):
    assert not same_subject(left, right)
    assert not same_subject(right, left)


def test_a_non_ascii_subject_still_matches_itself():
    # Preserving the letters has to leave a *key*, not an empty tuple -- a
    # pure-CJK subject used to fold away entirely.
    assert descriptor_key("抹茶 latte") == ("抹茶", "latte")
    assert same_subject("抹茶 Latte", "  抹茶   latte ")


def test_accents_still_fold_because_that_is_the_same_word():
    # The intended win, unchanged: combining marks are stripped.
    assert fold("açaí") == "acai"
    assert same_subject("açaí bowls", "acai bowl")


def test_a_key_that_folds_to_nothing_never_matches_another_empty_key():
    # Punctuation, or nothing but stop words, on either side.
    assert not same_subject("---", "***")
    assert not same_subject("the", "the")
    assert not same_subject("of the", "for the")
    assert not same_subject("rucking vests", "the")


# --- singular/plural folding is symmetric ----------------------------------


@pytest.mark.parametrize(
    ("singular", "plural"),
    [
        # The `es` branch used to return early, so "lenses" reached "lens"
        # while "lens" reached "len" -- the two did not compare equal.
        ("lens", "lenses"),
        ("virus", "viruses"),
        ("bus", "buses"),
        ("glass", "glasses"),
        # No -ies rule at all before this, in a pipeline with a supplements
        # vertical.
        ("gummy", "gummies"),
        ("smoothie", "smoothies"),
        ("vest", "vests"),
        ("patch", "patches"),
    ],
)
def test_a_word_and_its_plural_fold_to_one_key(singular, plural):
    assert descriptor_key(singular) == descriptor_key(plural)
    assert same_subject(singular, plural)
    assert same_subject(plural, singular)


def test_an_ous_word_is_not_mangled():
    # "hypochlorous acid spray" is a live descriptor. The `s` is the word.
    assert descriptor_key("hypochlorous acid spray") == (
        "hypochlorous",
        "acid",
        "spray",
    )
    assert same_subject("hypochlorous acid sprays", "hypochlorous acid spray")
