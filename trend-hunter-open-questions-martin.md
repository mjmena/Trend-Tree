# Trend Hunter Tools Sync — open questions

Compiled 2026-09-10 by Martin Mena from the recurring **Trend Hunter Tools Sync** meeting
(organizer Johnna Logan, 2x/week Google Meet, running since 2026-04-01 under the earlier name
"Trend Agent Sync"). This covers every topic raised in that series — audience/persona work,
heat index and prediction, Maya/MAIA, ecomm, and anything else — not just one workstream.

## Scope and how to read this

**Read in depth**: 20 of roughly 37 meetings in the series, spanning 2026-03-23 through
2026-09-10, prioritized by recency (an open question from March is more likely already
resolved than one from last week). Two meetings (2026-07-17, 2026-07-21) were only available
as a truncated preview (Quick Notes, not the full transcript) — flagged inline where that
limits confidence.

**Not yet read**: 15 meetings from the early build-up period — 2026-04-17, 05-15, 05-19,
05-26, 05-29, 06-02, 06-05, 06-09, 06-12, 06-16, 06-23, 06-30, 07-07 (×2), 07-10, 07-14. If
something below looks like it should have an earlier origin story, it's probably in one of
these.

**"Open question" here means**: something explicitly left undecided, a proposal that was never
confirmed as a settled decision, an action item that implies an unresolved question behind it,
or a live disagreement. It does not mean everything discussed — plenty was decided in these
meetings and isn't repeated here.

**One pattern worth naming up front**: several items below were raised once as an action item
and never mentioned again in any later meeting read. That's suggestive of "quietly resolved and
never reported back," but it's not proof — treat these as *last known status: open, not
revisited in available notes*, not as confirmed still-live blockers. They're marked accordingly.

---

## Audience / Persona

1. **Persona capping mechanism never confirmed built.** 2026-08-14 — discussed "a capping
   mechanism ... so it doesn't just spin up 10,000" personas. Floated, not assigned an owner or
   a build ticket in anything read afterward.
2. **Who can create new personas — Harbor alone, or also CSA/Atlas?** 2026-08-14 — Marcelo
   asked directly; Martin's answer ("my gut instinct is...") was explicitly provisional, not a
   decision.
3. **Does the Atlas→CSA→CMS→Snowflake data contract already exist, or is it net-new?**
   2026-09-01 — Kathryn: "I don't think we have a full document of that contract end to end ...
   is this a new thing that we need for Pierce's, or does it already exist? Can we use any of
   these pieces?" A doc was only just started at the time.
4. **No way found to automate a behavioral cohort in Amplitude.** 2026-08-07 (Trendhunter
   Interaction Data Walkthrough) — Martin: "there is no way to automate a behavioral cohort in
   Amplitude ... I don't think I have not found a way to have an agent or a user create that
   from outside of Amplitude." He planned to ask Amanda; no resolution found in later meetings.
   *Last known status: open, not revisited.*
5. **Where does "behavioral" audience data (platform activity like TikTok/Instagram usage)
   live — Harbor or elsewhere?** 2026-07-24 — Martin: "some of that data likely might have to
   exist outside of Harbor right now." Harbor's scope boundary (hard demographics vs.
   behavioral/LLM-inferred data) was still being negotiated live.
6. **Chicken-or-egg on interest profiles vs. personas.** 2026-08-07 (main sync) — Jason asked
   whether to start from a fixed persona set and build interest profiles around it, or let
   profiles churn and back-fit into personas later. Discussed, not resolved; Kathryn flagged the
   risk of ending up with "thousands or hundreds of thousands" of personas.

## Heat index & prediction

7. **No prediction workflow exists.** 2026-08-04 — Jason asked point-blank: "is there a
   workflow outlined somewhere right now from any of us that detail what we expect to happen
   with predictions?" Sara: "No." Manual curation was agreed as a stopgap; the long-term
   workflow was explicitly left undefined.
8. **Predictions: Atlas-automated vs. CMS-manual, undecided.** 2026-08-04 — "What has not been
   decided is whether predictions are coming from Atlas or if it's something that is being
   manually created via the CMS." Deferred pending qualitative testing; as of 2026-08-11 still
   "postponed until after the August 25 milestone."
9. **Prediction lifecycle reflagging bug.** 2026-08-04 — Martin: predictions "are not being
   reflagged ... flagged once early in their life cycle and then they're not being re-flagged
   again." Martin owned a fix; no later transcript confirms it landed. *Last known status: open,
   not revisited.*
10. **Demographic-seeding cost decision never confirmed.** 2026-08-04 — Martin was withholding
    full seeding of ~300 trends' demographic data pending a cost conversation with "Justin."
    Outcome not found in any later meeting. *Last known status: open, not revisited.*

## Ecomm

Full ecomm coverage (four parallel sourcing efforts, the Shopify token/catalog staleness, the
"is every article a commerce article?" ownership question, the Amazon informal track) is in
[`ecomm-knowledge-compilation-martin.md`](ecomm-knowledge-compilation-martin.md) — not repeated
here. Two items surfaced in this pass that weren't in that doc:

11. **Manual Shopify Collective sourcing is still a bottleneck.** Recurs across 2026-07-21
    (preview only), 07-24, 08-04, 08-18, 08-21, 08-25 — consistently described as
    manual/unautomated the whole way through; no meeting shows this resolved.
12. **Non-Atlas trend content degrades the recommendation engine — mitigation undecided.**
    2026-08-25 (10:30 instance) — Emil explained content not tied to an Atlas trend has no
    embeddings/categories, hurting recommendations. Jason and Kathryn proposed a separate
    "content-led collection path" with editorial labeling; Emil "agreed to investigate further."
    No confirmation this shipped.

## Maya / MAIA

13. **Maya suggesting trends the company doesn't actually have.** 2026-08-11 — reported by
    Sara; Marcelo working with Derek to scope down what Maya sees. Open/in-progress as of
    08-11, not confirmed fixed in any later transcript.
14. **Direct Atlas↔Maya connection requested, not confirmed built.** 2026-08-27 — Marcelo asked
    Derek for "a direct, exclusive connection between Atlas and Maya" to improve stability. As
    of 2026-09-10, Harbor/Maya research is still described as "not 100% wired yet," suggesting
    this or a related integration remains incomplete.

## Other

15. **Alice API has no credentials.** 2026-09-03 — Emil: "the Alice API currently has no
    credentials." Emil/Marcelo to coordinate once activated. Not mentioned again in the 09-10
    transcript. *Last known status: open, not revisited.*
16. **Workflow confusion Jason raised repeatedly, never fully closed.** 2026-08-18 — Jason:
    "I still felt like maybe there's a misunderstanding about ... where personas are applied,"
    and separately questioned whether the whole Atlas/CSA/CMS flow was "fundamentally different
    from how we've talked about the workflow." Sara's recorded walkthrough was the agreed
    remedy, but Jason's own framing ("we're trying to solve a now problem and a later problem")
    signals this was managed, not resolved.

## Sources

Meeting transcripts read in full (2026-03-23 through 2026-09-10): 2026-03-23, 05-22, 06-26,
07-24, 08-04, 08-07 (side meeting: Trendhunter Interaction Data Walkthrough), 08-11, 08-14,
08-18, 08-21, 08-25 (two instances), 08-27, 09-01, 09-03, 09-08, 09-10, plus the master
cumulative "Notes - Trend Agent Sync" doc. 2026-07-17 and 07-21 read only via truncated Quick
Notes preview. Not yet read: the 15 early-period meetings listed under Scope above.
