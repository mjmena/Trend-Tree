# Amazon Partner Tag — discovery questionnaire

**Purpose:** unblock live testing of the Amazon Creators API (and PA-API) credentials against
Trend Tree's ecomm work. The auth flow is fully wired and tested — every request fails on one
missing field: the Partner Tag (Associates Tracking ID). This questionnaire exists to get that
value, or find out why it doesn't exist yet.

**From:** Martin Mena — **To:** Blake Morgan — **How your answers will be used:** to make a
real product-search call against Amazon's catalog, as part of exploring how ecommerce data
feeds Trend Hunter/Trend Tree.

*(Assumed you're the Blake who handed over the Creators API credential — flag if that should
have gone to someone else.)*

## Context

You gave Martin a Credential ID/Secret pair for Amazon's Creators API (version 2.1) and
separately an Access Key ID for the legacy PA-API 5.0. Both were tested today: the OAuth token
exchange succeeds, and a test `SearchItems` call reached Amazon's catalog service correctly —
but Amazon rejected it with `InvalidPartnerTag`, because no Partner Tag (also called an
Associates Tracking ID or Store ID) was included. Every Creators API and PA-API request requires
one; it's not something either API can return on its own. Separately, a Jira ticket from
2026-08-20 (CRMA-755, written by Martin) notes that at the time, "there is no Amazon Associates
table anywhere in this account, and both Amazon lanes have been dormant since May 2026" — so
part of what's needed here is just confirming the account's current state.

## How to answer

No hard deadline, but this is the one thing blocking any further exploration, so sooner helps.
Should take under 10 minutes if you have Associates Central access — most of this is "look at
one page and tell me what it says." Partial answers are fine; flag anything you're not sure of
rather than skipping it.

## The Partner Tag and account status

### What is the exact Partner Tag (Tracking ID / Store ID) tied to the credentials you gave Martin?

_Why this matters: this is the literal missing field — every Creators API and PA-API request
needs it verbatim._

>

### Which Amazon Associates account is this credential under — do you know its name or account ID?

_Why this matters: CRMA-755 (2026-08-20) found no Associates table in McClatchy's account at
all. If this is a different or newly (re)activated account, worth knowing which._

>

### If no Tracking ID has been created yet, can one be created now — and who has admin access to Associates Central to do that?

>

### Is there a specific marketplace/region this credential is scoped to (e.g. US / www.amazon.com), or should that be assumed?

>

## Anything else?

Anything about how this credential is meant to be used, or who else should be looped in, that
we didn't ask above?

>
