# CRMA-1325: can a query shape or a specificity filter lift TikTok to the 30% bar?

Prototype date: 2026-09-28 (UTC). 21 billed SerpApi calls, 108 results. Grader and
rubric are the same as CRMA-1317 (`distillation.subagent.system` v5). **Every result
was graded before either filter ran**, so the grades do not depend on filter output.

## How the sample was pulled

`engine=google_short_videos`, `tbs=qdr:d`, `gl=us&hl=en`, the 6 CRMA-1320 seeds.

| Shape | Query | Calls | Calls with results | Results |
|---|---|---|---|---|
| base (CRMA-1320 shape, control) | `site:tiktok.com <seed>` | 6 | 5 (`kitchen gadget`: 0) | 60 |
| launch | `site:tiktok.com new <seed> launch` | 6 | 2 (snack, sneakers) | 24 |
| viral | `site:tiktok.com trying the viral <seed>` | 6 | 0 (5 empty, 1 timeout) | 0 |
| dupe | `site:tiktok.com <seed> dupe` (skincare, sneakers, snack) | 3 | 2 | 24 |

`google_short_videos` returns no snippet for these results, so a filter sees the
**title only**. Post times decode from the video ID (`id >> 32`): all but 3 of the
108 videos are under 1.5 days old.

## The two filters

- **LLM filter**: first run on Gemini 2.5 Flash, then re-run on `gemini-3.7-flash`
  and `gemini-3.8-flash` (see **Model comparison**). Temperature 0, JSON output,
  40 titles per call. **The decided model is `gemini-3.7-flash`.**
  The prompt restates the rubric's test ("a noun phrase you can put on a slide and a
  verb a consumer is doing"), its good examples, and a drop list: categories,
  routines, listicles, hauls, rankings, unboxings of established products, brand
  ads, deal posts. 3 calls, 13,964 tokens (8,070 of them thinking) for 108 titles.
- **Regex filter**: drops titles that match listicle, routine, haul, ranking,
  "finds", "best", "link in bio" patterns.

## Results

| Shape | Filter | Kept | PASS | Pass rate | PASS + BORDER |
|---|---|---|---|---|---|
| base | none | 60 | 5 | 8% | 18% |
| base | regex | 35 | 4 | 11% | 26% |
| base | **LLM** | **12** | **5** | **42%** | 75% |
| launch | none | 24 | 0 | 0% | 29% |
| launch | LLM | 11 | 0 | 0% | 55% |
| dupe | none | 24 | 3 | 12% | 33% |
| dupe | LLM | 4 | 1 | 25% | 100% |
| all | LLM | 27 | 6 | 22% | 70% |

- **Query shapes fail.** 11 of the 15 new-shape calls return nothing:
  `google_short_videos` returns 0 for most multi-word queries. `launch` finds only
  single-product brand launches (0 PASS). `dupe` finds 3 PASS, 2 of them topics we
  already carry.
- **The LLM filter clears the bar on the control shape.** It keeps all 5 base PASS
  results, including the 3 that are new to us, and drops 48 of 55 non-PASS.
  Its leak is sneaker model and colorway posts (5 of the 8 FAILs it kept).
  It drops 2 dupe-shape PASS (Dollar Tree dupes of Rhode, PDRN masks).
- **The regex filter does not help.** It drops 2 PASS and keeps most sneaker
  and brand posts.

### Model comparison

The first run used `gemini-2.5-flash`, which is not the fleet target. The same
prompt was re-run on the same 108 titles with the fleet target `gemini-3.7-flash`
(CRMA-726) and with `gemini-3.8-flash`. The grades did not change. The filter call
is not grounded, so the grounded-truncation defect CRMA-726 found in 3.7 Flash
does not apply.

| Model | Base: kept, PASS | All shapes: kept, PASS | PASS dropped | Tokens (108 titles) |
|---|---|---|---|---|
| `gemini-2.5-flash` | 12, 5 (42%) | 27, 6 (22%) | Dollar Tree dupes, PDRN masks | 13,964 |
| **`gemini-3.7-flash`** | **11, 5 (45%)** | **20, 7 (35%)** | Dollar Tree dupes | 10,180 |
| `gemini-3.8-flash` | 5, 3 (60%) | 10, 5 (50%) | protein snack, Vans sneaker loafer, Dollar Tree dupes | 11,051 |

`gemini-3.7-flash` is the decided model. It keeps 7 of 8 PASS results and clears
the bar across all shapes. `gemini-3.8-flash` has a higher rate but drops the Vans
sneaker loafer, a new-to-us topic, and keeps only 10 results.

### Limits of this sample

- **42 of the 60 base results repeat the CRMA-1317 sample**, which ran hours earlier
  on the same day with the same queries. All 5 base PASS results are among the
  repeats; the 18 new base results hold 0 PASS. The base shape is therefore close
  to a re-test of the CRMA-1317 items, and 12 kept results is a small base for a
  42% rate.
- One grader graded both samples. The filter prompt was written after reading
  CRMA-1317, so it is not independent of that sample.
- The day-over-day repeat rate of a daily run is not measured.

### Earliness of the new PASS topics

`ILIKE` over `FCT_SIGNALS.SIGNAL_TITLE || SIGNAL_TEXT`, 2026-09-28:

| Topic | FCT_SIGNALS | First seen | Verdict |
|---|---|---|---|
| charcuterie chips (dupe) | 0 | — | new to us |
| Dollar Tree dupes of prestige skincare (dupe) | 0 (Rhode + dupe: 2) | 2025-08-14 | partly known |
| PDRN masks (dupe) | 319, 9 sources | 2025-02-02 | late |

Base PASS topics carry the CRMA-1317 earliness verdicts: Vans sneaker loafer,
peanut butter popcorn and magnesium + B6 are new to us; protein snack and magnesium
glycinate are late.

## Cost per run under the 50-call cap

- SerpApi: 50 calls at ~$0.009 = ~$0.45 of the shared plan's quota per run.
- `gemini-3.7-flash` filter: ~95 tokens per title including thinking. At ~12
  results per productive call, 50 calls give ~600 titles, ~57K tokens, under
  $0.25 per run.

## All 108 results

| # | Shape | Seed | Grade | LLM keeps | Regex keeps | Title | Why |
|---|---|---|---|---|---|---|---|
| 0 | base | supplement | FAIL | no | yes | This supplement stack is so powerful. You have to check with ... |  |
| 1 | base | supplement | FAIL | no | yes | This is where I always go wrong with supplements. Which one ... |  |
| 2 | base | supplement | FAIL | no | yes | The Supplements men actually NEED‼ Follow for more ... |  |
| 3 | base | supplement | FAIL | no | no | Ranking the best supplements for men's health ... |  |
| 4 | base | supplement | FAIL | no | yes | I was taking supplements every single day, until I realized I was ... |  |
| 5 | base | supplement | FAIL | no | yes | You need to watch this if you're wondering what the side effects ... |  |
| 6 | base | supplement | PASS | yes | yes | ‏Magnesium + B6 = the duo you want together. ... | magnesium + B6 pairing |
| 7 | base | supplement | FAIL | yes | yes | Pure Form® Ultra-Micronized™ Creatine helps replenish ... |  |
| 8 | base | supplement | BORDER | no | yes | Supplements that help you sleep #blackgirlvitamins ... | sleep supplements, brand plug |
| 9 | base | supplement | BORDER | yes | yes | Collagen + Vitamin C — a simple addition to your daily ... | collagen + vitamin C, evergreen pairing |
| 10 | base | supplement | FAIL | yes | yes | #orgain #protein #clearprotein #supplement #zerosugar |  |
| 11 | base | supplement | PASS | yes | yes | Magnesium glycinate liquid capsules for relaxation, sleep ... | magnesium glycinate for sleep |
| 12 | base | snack | BORDER | yes | yes | This Cajun Cheddar Snack Mix is crunchy, cheesy, buttery, and ... | one creator's snack-mix recipe |
| 13 | base | snack | FAIL | no | yes | I love a good healthy snack. I love peanut butter. I love jelly. I lov... |  |
| 14 | base | snack | FAIL | no | yes | Easy Late Night Snack Ideas |  |
| 15 | base | snack | PASS | yes | yes | This peanut butter popcorn is the sweet-and-salty fall snack I ... | peanut butter popcorn as fall snack |
| 16 | base | snack | FAIL | no | yes | Healthy Snacks To Lose Weight Now, if you need a full plan ... |  |
| 17 | base | snack | FAIL | no | yes | Snack/Lunch Of The Day 9-21-26 ... |  |
| 18 | base | snack | FAIL | no | no | What's your go to Disneyland snack!? Have you had any of ... |  |
| 19 | base | snack | FAIL | no | yes | New favorite snack alert who can guess what it is?! #tiki ... |  |
| 20 | base | snack | FAIL | no | yes | Just a quick little afternoon snack #snacks # ... |  |
| 21 | base | snack | FAIL | no | yes | Easy toddler meal prep for a week of never ending snack ... |  |
| 22 | base | snack | PASS | yes | yes | Finally a protein snack doesn't taste like , this banana cream ... | banana-cream protein snack |
| 23 | base | snack | FAIL | no | yes | THE GAME DAY SNACK YOU'LL MAKE ON REPEAT! Need ... |  |
| 24 | launch | snack | FAIL | no | yes | the All new RNR Rogue Swimmer drops tomorrow at 8pm on ... |  |
| 25 | launch | snack | BORDER | yes | yes | Turns out Granola Bites are kind of a big deal at UT @Tinx ... | granola bites, creator brand plug |
| 26 | launch | snack | BORDER | yes | yes | #gifted Only Snacks Dill Pickle Crunchy Roasted Edamame! ... | dill pickle roasted edamame, gifted brand plug |
| 27 | launch | snack | FAIL | no | yes | Received two boxes of these and one is completely gone ... |  |
| 28 | launch | snack | BORDER | yes | yes | New Aldi Cheesecake Cookie Sandwich ... | one Aldi product launch |
| 29 | launch | snack | FAIL | no | yes | time for your european snack cravings! We're now open 11 AM ... |  |
| 30 | launch | snack | BORDER | yes | yes | The mini burgers that went viral are back—with a bigger home! ... | one restaurant's viral mini burgers |
| 31 | launch | snack | FAIL | no | yes | my fav sweet breakfast item i've had in a longggg time ... |  |
| 32 | launch | snack | BORDER | yes | yes | Trying the Cadbury &More Caramel Nut Crunch. Creamy ... | one Cadbury product review |
| 33 | launch | snack | FAIL | no | yes | Which ones do you think are empty? #protein # ... |  |
| 34 | launch | snack | BORDER | no | yes | Realistic Fruit Dessert Battle (Part 4) #hungryFAM #tucha ... | realistic fruit desserts, aesthetic but a battle video |
| 35 | launch | snack | FAIL | no | yes | OMG LOOK WHATS NEW IN HOME BARGAINS ... |  |
| 36 | base | skincare | FAIL | no | no | Hydrating skincare routine These are some of the products I ... |  |
| 37 | base | skincare | FAIL | no | yes | Night Skincare |  |
| 38 | base | skincare | FAIL | no | no | my skincare routine since y'all keep asking Products used |  |
| 39 | base | skincare | FAIL | no | no | The skincare routine I'm always packing when I travel Products |  |
| 40 | base | skincare | FAIL | no | no | Simple Skincare routine with BASED #BASED |  |
| 41 | base | skincare | FAIL | no | no | What is your Skincare routine? #BASED |  |
| 42 | base | skincare | FAIL | no | no | Current morning routine for that insane skin glow! #skincare ... |  |
| 43 | base | skincare | FAIL | no | no | Best skincare for sensitive skin at Target #gentleskincare # ... |  |
| 44 | base | skincare | FAIL | no | no | The main things that helped was using skincare routine ... |  |
| 45 | base | skincare | FAIL | no | yes | Skincare swaps that actually work based on clinical evidence. ... |  |
| 46 | base | skincare | FAIL | no | no | The #1 question for Rob Lowe? His skincare routine. Here it is |  |
| 47 | base | skincare | FAIL | no | yes | my current favs ... / skincare |  |
| 48 | base | sneakers | FAIL | no | yes | Sneakers from @kicksonsneakers I hope that my dad likes ... |  |
| 49 | base | sneakers | FAIL | no | yes | Sneaker Unboxing / Styling Nike Airforce 1 Triple White ... |  |
| 50 | base | sneakers | FAIL | no | yes | Friends and family #fyp #sneakertok #nike ... |  |
| 51 | base | sneakers | FAIL | no | yes | #Nike #AirMax #shoeCheck #sneakerhead |  |
| 52 | base | sneakers | PASS | yes | no | Vans might have just made the best sneaker loafer we've seen ... | Vans sneaker loafer |
| 53 | base | sneakers | FAIL | yes | yes | White sb dunk #wholesomekicks #viral #foryou #sneakers ... |  |
| 54 | base | sneakers | BORDER | yes | yes | Your everyday sneaker obsession The New Balance 530s ... | New Balance 530, evergreen |
| 55 | base | sneakers | FAIL | no | no | stepped out for the ootn and these are definitely still top 5 ... |  |
| 56 | base | sneakers | FAIL | no | yes | if you need a pink and white sneakers, this one is for you |  |
| 57 | base | sneakers | FAIL | no | yes | Your 1 Stop For Quality Sneakers #amx #0632151973 ... |  |
| 58 | base | sneakers | FAIL | no | no | Ranking Top 4 Yellow Air Jordan 4s #Jordan4 ... |  |
| 59 | base | sneakers | BORDER | yes | yes | some sneakers are trendy but the onitsuka tiger mexico 66 just ... | Onitsuka Tiger Mexico 66, evergreen since 2024 |
| 60 | launch | sneakers | FAIL | yes | yes | The baddest sneakers are in Sole Avenue #goldengoose ... |  |
| 61 | launch | sneakers | FAIL | no | yes | Friends and family #fyp #sneakertok #nike ... |  |
| 62 | launch | sneakers | FAIL | yes | yes | 2019 Supreme x Nike Dunk SB Low ' Varsity Red ' High ... |  |
| 63 | launch | sneakers | BORDER | yes | yes | Oasis 2027 x Adidas / Today 6PM. Limited edition (Only 100 ... | one sneaker collab drop |
| 64 | launch | sneakers | FAIL | yes | yes | Cactus Jack Travis Sb Dunks #howkick #shoes #sneakers |  |
| 65 | launch | sneakers | FAIL | no | yes | I think I'm right about this |  |
| 66 | launch | sneakers | FAIL | yes | yes | Butta Cookie Answers @Reebok #alleniverson ... |  |
| 67 | launch | sneakers | FAIL | no | yes | NBA Trikots verschiedene Modelle |  |
| 68 | launch | sneakers | FAIL | no | yes | NBA Trikots verschiedene Modelle |  |
| 69 | launch | sneakers | FAIL | no | yes | #creatorsearchinsights ….the easy everyday sneakers from @ ... |  |
| 70 | launch | sneakers | FAIL | yes | yes | Vybes… #jordan9s #givethanks #thisworld #fashion #enjoylife |  |
| 71 | launch | sneakers | FAIL | no | yes | Come Run 21.1KM with @madshemson at the Nike After Dark ... |  |
| 72 | base | amazon finds | FAIL | no | no | POV: You stumble across 7 Amazon finds that actually solve ... |  |
| 73 | base | amazon finds | FAIL | no | no | 20 AMAZON USEFUL FINDS worth adding to your radar. This ... |  |
| 74 | base | amazon finds | FAIL | no | no | 21 Amazon Products That Always Get Five Stars LINK IN BIO ... |  |
| 75 | base | amazon finds | FAIL | no | no | 20 Amazon products you didn't know you needed ... |  |
| 76 | base | amazon finds | FAIL | no | no | Amazon finds you didn't know you needed ... |  |
| 77 | base | amazon finds | FAIL | no | no | Amazon home finds I don't regret buying ... |  |
| 78 | base | amazon finds | FAIL | no | no | 10 things you need when you don't have enough space! Linked ... |  |
| 79 | base | amazon finds | FAIL | no | no | some of the things I got from Amazon but full haul gon be in ... |  |
| 80 | base | amazon finds | FAIL | no | no | amazon finds for the cool girls! Link in my bio for the store front ... |  |
| 81 | base | amazon finds | FAIL | no | no | Amazon Finds that went from "Just Trying It" to why I didn't buy ... |  |
| 82 | base | amazon finds | FAIL | no | yes | Amazon Tech Products You'll Wish You Bought Sooner! |  |
| 83 | base | amazon finds | BORDER | no | no | My best Amazon find to date #lolablanket #blankets ... | Lola blanket, one product, known since 2023 |
| 84 | dupe | skincare | FAIL | no | yes | skincare - Dupe Score |  |
| 85 | dupe | skincare | PASS | no | no | My latest Dollar Tree finds that are dupes for Rhode Skin, Glow ... | Dollar Tree dupes of Rhode / prestige skincare |
| 86 | dupe | skincare | FAIL | no | yes | I'm thrilled to try out all of these dupes! I will make a video lettin... |  |
| 87 | dupe | skincare | PASS | no | yes | Reviewing the new PDRN masks & new Summer Fridays ... | PDRN sheet masks |
| 88 | dupe | skincare | FAIL | no | no | This is a weekly routine @UNOVE.global @K18 Hair ... |  |
| 89 | dupe | skincare | FAIL | no | yes | Long story short, the item is no longer seasonal, I bought 4 ... |  |
| 90 | dupe | skincare | FAIL | no | no | @Dollar Tree finds #dollartree #dollartreefinds ... |  |
| 91 | dupe | skincare | FAIL | no | yes | Replying to @maryanncelesterdz Im loving everything!!! # ... |  |
| 92 | dupe | skincare | FAIL | no | yes | Yall know I love me a good sale & DUPES in my bio!!!! Or ... |  |
| 93 | dupe | skincare | BORDER | no | no | The best dupeeeeee GOSH @bliss.cosmetics #foryourpage ... | one brand dupe |
| 94 | dupe | skincare | FAIL | no | yes | So here are swatches for the 5 of the 6 New @LA COLORS ... |  |
| 95 | dupe | skincare | FAIL | no | yes | I love a good @Dollar Tree truck day! Finally spotted the ... |  |
| 96 | dupe | snack | PASS | yes | yes | Let's make the viral charcuterie chips together, AKA girl dinner ... | charcuterie chips (girl dinner) |
| 97 | dupe | snack | BORDER | no | yes | Brand New Co-Op irresistible cookies… Full taste test incoming | one Co-op cookie taste test |
| 98 | dupe | snack | BORDER | yes | yes | I made candy corn milk and turned it into a latte for Tom to try. ... | candy corn milk latte, one creator's recipe |
| 99 | dupe | snack | FAIL | no | yes | I love that @Shorty mom loves to go out & eat like me & ... |  |
| 100 | dupe | snack | FAIL | no | yes | my first ever dumpling unboxing!! yes theyre dupes no i dont ... |  |
| 101 | dupe | snack | BORDER | yes | yes | NEW Cookies & Cream, Maple Glazed Protein Donuts from ... | protein donuts, one brand launch |
| 102 | dupe | snack | FAIL | no | yes | Tunnocks variety box. Full of the absolute classics! Caramel ... |  |
| 103 | dupe | snack | BORDER | yes | yes | Fluffy Cheese Pancakes – Quick & So Easy! These ... | fluffy cheese pancakes, one recipe |
| 104 | dupe | snack | FAIL | no | yes | Trying NEW Walmart brand food releases! Have you tried ... |  |
| 105 | dupe | snack | FAIL | no | yes | Dinner with my boys #eatwithme #dishupdinnerwithme ... |  |
| 106 | dupe | snack | FAIL | no | yes | CHOCOLATE INDULGENCE IS HERE! Twix Miniatures ... |  |
| 107 | dupe | snack | FAIL | no | yes | $8 each !!! Dm me to order ... |  |
