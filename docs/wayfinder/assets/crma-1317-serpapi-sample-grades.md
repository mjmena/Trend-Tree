# CRMA-1317: SerpApi sample graded against the distillation specificity rubric

Prototype date: 2026-09-28 (UTC). 21 billed SerpApi calls, 145 results. Raw
responses were kept in the session scratch directory only; this file holds every
result and its grade.

## How the sample was pulled

One seed query per discovery vertical (CRMA-1320): `supplement` (wellness),
`snack` (food_beverage), `skincare` (beauty_personal_care), `sneakers`
(fashion_apparel), `kitchen gadget` (home_lifestyle), `amazon finds`
(commerce_retail). Query shapes are the ones CRMA-1320 decided, with `gl=us&hl=en`:

| Platform | Shape | Calls | Results |
|---|---|---|---|
| TikTok | `engine=google_short_videos`, `q=site:tiktok.com <seed>`, `tbs=qdr:d` | 6 | 60 (`kitchen gadget` returned 0) |
| Reddit | `engine=google_forums`, `q=<seed>`, `period_unit=d`, `period_value=1` | 7 (1 timeout retried) | 58 |
| Kickstarter | `engine=google`, `q=site:kickstarter.com/projects <seed>`, `tbs=qdr:w` | 6 | 8 (4 of 6 seeds returned 0) |
| Kickstarter (extra) | the research's best shapes: `"backers pledged"`, and bare `site:` page 2 | 2 | 19 |

## How each result was graded

The rubric is the live `distillation.lead.system` v7 / `distillation.subagent.system`
v5 text in `DIM_LLM_PROMPT`: a trend is a specific consumer behaviour, product use
case, aesthetic or cultural pattern, with "a noun phrase you can put on a slide and a
verb a consumer is doing". Categories, discourse and news fail. The rubric grades
clusters, so one result is graded on whether it could seed such a cluster:

- **PASS**: names a specific product, ingredient or practice a consumer is doing.
- **BORDER**: specific, but one creator's recipe, a brand plug, or evergreen.
- **FAIL**: generic routine, listicle, category, spam, off-topic, or not the platform.

The pass bar is the one GitHub #18 set for the retired TikTok ingester: **at least
30% of a spot-check passes the specificity floor**.

**Earliness** was checked for every PASS and BORDER topic with an `ILIKE` over
`FCT_SIGNALS.SIGNAL_TITLE || SIGNAL_TEXT` and `FCT_TRENDS.TREND_NAME` (2026-09-28).

## Results

| Platform | Results | PASS | BORDER | Pass rate | Pass + border | Fresh (≤ 1 day) |
|---|---|---|---|---|---|---|
| TikTok | 60 | 6 | 5 | **10%** | 18% | 57/60 by video-ID decode (3 were 2-3 days old) |
| Reddit tab | 58 | 0 | 3 | **0%** | 5% | 16/17 Reddit threads by post-ID range; only 17/58 results were Reddit |
| Kickstarter | 27 | 1 | 1 | **4%** | 7% | crawl date 2-7 days; no launch date |

No platform reaches the 30% bar.

### Earliness of the specific topics

| Topic (platform) | FCT_SIGNALS | First seen | Verdict |
|---|---|---|---|
| Vans sneaker loafer (TikTok) | 0 | — | new to us |
| peanut butter popcorn (TikTok) | 0 | — | new to us; one creator's recipe |
| rose water on cucumber (TikTok) | 0 | — | new to us; one creator's recipe |
| magnesium + B6 (TikTok) | 0 | — | new to us; supplement-marketing pairing |
| protein snack (TikTok) | 49, 7 sources | 2025-05-29 | late |
| magnesium glycinate (TikTok) | 51, 6 sources | 2023-11-02 | late |
| menopause / cortisol supplements (Reddit) | 12, 7 sources | 2026-01-14 | late |
| postpartum supplements (Reddit) | 5, 2 sources | 2026-05-16 | late |
| tinned fish (Reddit) | 52, 5 sources | 2023-07-27 | late |
| digital "film" camera (Kickstarter) | 2, bluesky | 2026-02-14 | late; campaign already funded |

## What the sample shows

- **TikTok** is fresh, but a category seed returns creator routines and "Amazon
  finds" listicles. `skincare` and `amazon finds` gave 0 passes out of 24. The 4
  new-to-us topics are single videos, not yet patterns.
- **The Reddit tab** is not a Reddit source. 41 of 58 results come from Facebook
  groups, SEO spam sites (promo codes, fake "reviews") and unrelated forums. The
  Reddit threads that do come back are fresh, but every specific one is a topic 2-7
  of our sources already carry. Their value is conversation depth (a 250+ comment
  r/Menopause thread), not new topics.
- **Kickstarter** returns almost nothing for a consumer seed (4 of 6 seeds: 0
  results). The index is dominated by tabletop games, comics and books, and the one
  consumer product was already funded with 8,925 backers.

## All 145 results

| # | Platform | Seed | Grade | Title | Posted / meta | Why |
|---|---|---|---|---|---|---|
| 0 | kickstarter | "backers pledged" | FAIL | 【Project Phoenix】 Japan's indie RPG feat. AAA talent! — ... | 6 days ago | not a consumer product (game, book, media, course) |
| 1 | kickstarter | "backers pledged" | FAIL | Sword Hero by Possible » Closed Alpha Update 2 » | 3 days ago | not a consumer product (game, book, media, course) |
| 2 | kickstarter | "backers pledged" | FAIL | Cohors Cthulhu: Tactics Adventure Wargame — Updates | 7 days ago | not a consumer product (game, book, media, course) |
| 3 | kickstarter | "backers pledged" | FAIL | ABE: Officially Licensed 5-Inch Articulated Action Figure | 6 days ago | not a consumer product (game, book, media, course) |
| 4 | kickstarter | "backers pledged" | FAIL | Unbroken: New Tales By Masters of Fantasy — Updates | 3 days ago | not a consumer product (game, book, media, course) |
| 5 | kickstarter | "backers pledged" | FAIL | The Art of Djinn's Pirate Deck - Spicy Artbook+Comics | 6 days ago | not a consumer product (game, book, media, course) |
| 6 | kickstarter | "backers pledged" | FAIL | Damp, Dark Doom: A Sodden Delve for Use With ... | 7 days ago | not a consumer product (game, book, media, course) |
| 7 | kickstarter | "backers pledged" | PASS | A Non-disposable Digital “Film” Camera by Rewindpix ... | 5 days ago | non-disposable digital 'film' camera; already funded, 8,925 backers; digicam on bluesky Feb 2026 |
| 8 | kickstarter | "backers pledged" | FAIL | LPCore: 4-in-1 Portable 45W 10000mAh Power Bank & ... | 7 days ago | not a consumer product (game, book, media, course) |
| 9 | kickstarter | (none) | FAIL | The Queen's Dilemma by Horrible Guild » Community » | 4 days ago | not a consumer product (game, book, media, course) |
| 10 | kickstarter | (none) | FAIL | Let's Play Volume 6 by Rocketship | 4 days ago | not a consumer product (game, book, media, course) |
| 11 | kickstarter | (none) | FAIL | Pull Me Apart Vol. 2 by Poposition Press | 5 days ago | not a consumer product (game, book, media, course) |
| 12 | kickstarter | (none) | FAIL | Punch to Defend by Kuro Naeda | 2 days ago | not a consumer product (game, book, media, course) |
| 13 | kickstarter | (none) | FAIL | Arcane Fantasies STL by Custom Miniatures | 6 days ago | not a consumer product (game, book, media, course) |
| 14 | kickstarter | (none) | FAIL | Wild, Whimsical, and Wondrous Reptiles & Amphibians | 5 days ago | not a consumer product (game, book, media, course) |
| 15 | kickstarter | (none) | FAIL | The Hunchback of Notre Dame - Illustrated Deluxe Edition | 6 days ago | not a consumer product (game, book, media, course) |
| 16 | kickstarter | (none) | FAIL | Art Society Deluxe Edition & Expansion by Mighty Boards | 4 days ago | not a consumer product (game, book, media, course) |
| 17 | kickstarter | (none) | BORDER | Herders to Home 2026 - Luxury Mongolian Yarn by Jon Hetts | 3 days ago | luxury Mongolian yarn |
| 18 | kickstarter | (none) | FAIL | The Isle of Penguins | 3 days ago | not a consumer product (game, book, media, course) |
| 19 | kickstarter | amazon finds | FAIL | The Complete AWS Certification Mastery Bundle with 90 ... | 3 days ago | not a consumer product (game, book, media, course) |
| 20 | kickstarter | supplement | FAIL | Taleen Kali is creating their 2nd album! | 3 days ago | not a consumer product (game, book, media, course) |
| 21 | kickstarter | supplement | FAIL | Cal McDonald: Plague of Evil & Other Stories by Steve Niles | 4 days ago | not a consumer product (game, book, media, course) |
| 22 | kickstarter | supplement | FAIL | DRAGON GUARDIAN ELODEA #1 - 3: Fantasy, Creatures ... | 6 days ago | not a consumer product (game, book, media, course) |
| 23 | kickstarter | supplement | FAIL | TESSAN AERO 70: Smart Travel Adapter for Global Travel | 4 days ago | not a consumer product (game, book, media, course) |
| 24 | kickstarter | supplement | FAIL | Complete Google Cloud Generative AI & ML Engineer w ... | 6 days ago | not a consumer product (game, book, media, course) |
| 25 | kickstarter | supplement | FAIL | Fred Perry's Gold Digger Remastered Book 4 | 6 days ago | not a consumer product (game, book, media, course) |
| 26 | kickstarter | supplement | FAIL | Punkin Fight! ( Limited Edition ) - Kickstarter | 6 days ago | not a consumer product (game, book, media, course) |
| 27 | reddit | skincare | FAIL | Simplifying a 30-step skincare routine for busy moms | 2 comments · 4 hours ago | not Reddit (Facebook) |
| 28 | reddit | skincare | FAIL | Best Skincare Routine (37F) : r/SkincareAddicts |  | generic routine, listicle, or off-topic |
| 29 | reddit | skincare | FAIL | Old Cells, Thin Skin: A New Review Makes the Case for ... | 16 hours ago | not Reddit (Rapamycin Longevity News) |
| 30 | reddit | skincare | FAIL | Jolie Beauty Promo Code: LEE – Save Up to 30% Off | 18 hours ago | not Reddit (LAprepSoccer) |
| 31 | reddit | skincare | FAIL | Eva Bloom Reviews – Tried It So You Can Decide Better! | 16 hours ago | not Reddit (ewebdiscussion.com) |
| 32 | reddit | skincare | FAIL | Chat | 3 hours ago | not Reddit (Gransnet) |
| 33 | reddit | skincare | FAIL | are boneless people always going to age like milk? | 19 hours ago | not Reddit (Looksmaxxing Forum) |
| 34 | reddit | skincare | FAIL | Hydrossential Reviews – Tried It So You Can Decide Better! | 16 hours ago | not Reddit (ewebdiscussion.com) |
| 35 | reddit | skincare | FAIL | Aurora Skin Promo Code "LEEJEAM" – Save Up to 40% Off | 15 hours ago | not Reddit (LAprepSoccer) |
| 36 | reddit | skincare | FAIL | 💬 Discussion - Haircuts sound gay to me / | 4 hours ago | not Reddit (nutria.onl) |
| 37 | reddit | amazon finds | FAIL | What are some affordable textured print beds with Amazon ... | 3 comments · 23 hours ago | not Reddit (Facebook) |
| 38 | reddit | amazon finds | FAIL | How can I find out which marketplace store this charge ... |  | generic routine, listicle, or off-topic |
| 39 | reddit | amazon finds | FAIL | Voice goes Out | 10 hours ago | not Reddit (Amazon Digital and Device Forum) |
| 40 | reddit | amazon finds | FAIL | https://www.fordtremor.com/threads/ghost-october-t... |  | not Reddit (Ford Tremor Forum) |
| 41 | reddit | amazon finds | FAIL | Record Amazon Prime & Sports on DIRECTV Genie | 18 hours ago | not Reddit (JustAnswer) |
| 42 | reddit | amazon finds | FAIL | Amazon training gear - PC General Discussion | 8 hours ago | not Reddit (Blizzard Forums) |
| 43 | reddit | amazon finds | FAIL | Nobody: the amazon flex app: : r/AmazonDSPDrivers |  | generic routine, listicle, or off-topic |
| 44 | reddit | amazon finds | FAIL | Top 10 Free Amazon Gift Card Codes That Actually Work | 13 hours ago | not Reddit (ProBoards) |
| 45 | reddit | amazon finds | FAIL | G.I. JOE: Battle for the Arctic Circle $28.49 (Amazon Prime) | 15 hours ago | not Reddit (BGG) |
| 46 | reddit | amazon finds | FAIL | Amazon Just Knocked $900 Off Apple's Latest 16-Inch ... | 13 hours ago | not Reddit (MacRumors Forums) |
| 47 | reddit | sneakers | FAIL | Needed something to match my sneakers 😍 | 2 comments · 15 hours ago | not Reddit (Facebook) |
| 48 | reddit | sneakers | FAIL | Sneakers possibly stolen or overthinking it? / Buying | 19 hours ago | not Reddit (eBay Community) |
| 49 | reddit | sneakers | FAIL | https://www.reddit.com/r/Sneakers/comments/1b7v1ef... |  | generic routine, listicle, or off-topic |
| 50 | reddit | sneakers | FAIL | https://www.quora.com/Do-Adidas-sneakers-have-good... |  | not Reddit (Quora) |
| 51 | reddit | sneakers | FAIL | The best sneaker deals of the week 🚀 | 10 hours ago | not Reddit (DressedWell) |
| 52 | reddit | sneakers | FAIL | Cyber Techwear Promo Code: LEEJEAM – Save Up to 30% Off | 15 hours ago | not Reddit (LAprepSoccer) |
| 53 | reddit | sneakers | FAIL | Skechers Women Arch Arcade-Meet Ya There Sneaker | 23 hours ago | not Reddit (Woot) |
| 54 | reddit | sneakers | FAIL | Puma Hypnotic Ls Erkek Sneakers Siyah 39529502 38 No | 11 hours ago | not Reddit (Donanım Arşivi Forum) |
| 55 | reddit | sneakers | FAIL | https://www.usmessageboard.com/threads/president-t... |  | not Reddit (US Message Board 🦅) |
| 56 | reddit | sneakers | FAIL | Best Termite Inspection Services in Pocatello, ID | 4 hours ago | not Reddit (Yelp) |
| 57 | reddit | snack | FAIL | Best summer snack: sliced tomato with salt and pepper | 1 comment · 9 hours ago | not Reddit (Facebook) |
| 58 | reddit | snack | FAIL | Is anyone interested in a social snack rating app? |  | generic routine, listicle, or off-topic |
| 59 | reddit | snack | FAIL | Snack time! : r/KoreanFood |  | generic routine, listicle, or off-topic |
| 60 | reddit | snack | FAIL | People Work via Robot Mama Avatars at New Snack Bar in ... | 14 hours ago | not Reddit (ResetEra) |
| 61 | reddit | snack | FAIL | Are these snacks for one day or the week? / Toronto, ON |  | not Reddit (Facebook) |
| 62 | reddit | snack | FAIL | Snack bar house : r/GroundedGame |  | generic routine, listicle, or off-topic |
| 63 | reddit | snack | FAIL | Just a tip on the best snack ever : r/Netherlands |  | generic routine, listicle, or off-topic |
| 64 | reddit | snack | FAIL | Glucotrust Bites Reviews & Concerns : I Looked Into ... - Forums | 23 hours ago | not Reddit (Thermaltake) |
| 65 | reddit | snack | FAIL | Baked Masala Peanuts - Spicy Indian Snack Recipe |  | generic routine, listicle, or off-topic |
| 66 | reddit | snack | BORDER | Are your snacks boring? | 9 hours ago | tinned fish as a snack; known since 2023 (52 signals) |
| 67 | reddit | kitchen gadget | FAIL | What is this kitchen gadget used for? | 1 comment · 14 hours ago | not Reddit (Facebook) |
| 68 | reddit | kitchen gadget | FAIL | I knew what that one kitchen gadget did all along but no ... | 4 comments · 20 hours ago | generic routine, listicle, or off-topic |
| 69 | reddit | kitchen gadget | FAIL | I got so fed up with COOKING, I built two solving tools. - Reddit | 3 comments · 19 hours ago | generic routine, listicle, or off-topic |
| 70 | reddit | kitchen gadget | FAIL | What are these spinny thingies on the sides of a grocery cart ... | 50+ comments · 8 hours ago | generic routine, listicle, or off-topic |
| 71 | reddit | kitchen gadget | FAIL | What's the best food processor do you guys use and like? | 10+ comments · 14 hours ago | generic routine, listicle, or off-topic |
| 72 | reddit | kitchen gadget | FAIL | What is this utensil thingy? : r/whatisit - Reddit | 10+ comments · 5 hours ago | generic routine, listicle, or off-topic |
| 73 | reddit | kitchen gadget | FAIL | Favorite Cleaning Gadgets? : r/ChronicPain - Reddit | 10+ comments · 13 hours ago | generic routine, listicle, or off-topic |
| 74 | reddit | kitchen gadget | FAIL | Mini steam table/soup warmer : r/KitchenConfidential - Reddit | 6 comments · 13 hours ago | generic routine, listicle, or off-topic |
| 75 | reddit | supplement | FAIL | One complete supplement to add to food. Simple plz | 30+ comments · 4 hours ago | not Reddit (Facebook) |
| 76 | reddit | supplement | BORDER | What 3 supplements would you say are critical for you in ... | 250+ comments · 14 hours ago | menopause supplement stacks, cortisol support; known (12 signals, 7 sources) |
| 77 | reddit | supplement | FAIL | Evo Slim Netherlands Product Review A Practical Look at ... | 18 hours ago | not Reddit (Netlify Support Forums) |
| 78 | reddit | supplement | FAIL | TheyaVue Reviews – Tried It So You Can Decide Better! | 2 hours ago | not Reddit (ewebdiscussion.com) |
| 79 | reddit | supplement | FAIL | Trimoryn Review and Guide: Everything You Need to Know ... | 12 hours ago | not Reddit (fitness.com) |
| 80 | reddit | supplement | FAIL | DentaBiome: Is This the $49 Dental Supplement You've ... | 12 hours ago | not Reddit (Yesterday's Tractors) |
| 81 | reddit | supplement | FAIL | [TestoPrime™] Reviews & Complaints (2026): What We Found | 11 hours ago | not Reddit (LAprepSoccer) |
| 82 | reddit | supplement | BORDER | Postpartum Supplements - September 2026 Babies / Forums | 16 hours ago | postpartum supplements; known (5 signals) |
| 83 | reddit | supplement | FAIL | RSVP Preferred vs RSPV Recommended? | 18 hours ago | not Reddit (Insurance Forums) |
| 84 | reddit | supplement | FAIL | Natural medication availability | 12 hours ago | not Reddit (Felinediabetes.com) |
| 85 | tiktok | skincare | FAIL | Night Skincare | 2026-09-28 00:57 | generic routine, listicle, or off-topic |
| 86 | tiktok | skincare | FAIL | Hydrating skincare routine These are some of the products I ... | 2026-09-27 11:08 | generic routine, listicle, or off-topic |
| 87 | tiktok | skincare | BORDER | Cooking my way to glowing skin #glowup #skincare ... | 2026-09-27 20:35 | eating for skin; practice is known (64 signals) |
| 88 | tiktok | skincare | FAIL | Viral Korean skincare worth the purchase….imo # ... | 2026-09-27 20:38 | generic routine, listicle, or off-topic |
| 89 | tiktok | skincare | FAIL | Easy plant-based skincare! Skin by Nevéll Skin is up top | 2026-09-27 23:04 | generic routine, listicle, or off-topic |
| 90 | tiktok | skincare | FAIL | What is your Skincare routine? #BASED | 2026-09-27 00:57 | generic routine, listicle, or off-topic |
| 91 | tiktok | skincare | FAIL | my skincare routine since y'all keep asking Products used | 2026-09-27 15:43 | generic routine, listicle, or off-topic |
| 92 | tiktok | skincare | FAIL | Simple Skincare routine with BASED #BASED | 2026-09-27 17:16 | generic routine, listicle, or off-topic |
| 93 | tiktok | skincare | FAIL | The skincare routine I'm always packing when I travel Products | 2026-09-27 14:07 | generic routine, listicle, or off-topic |
| 94 | tiktok | skincare | FAIL | face mask hacks to get the most out of your skincare routine ... | 2026-09-27 17:32 | generic routine, listicle, or off-topic |
| 95 | tiktok | skincare | FAIL | Skincare swaps that actually work based on clinical evidence. ... | 2026-09-27 16:04 | generic routine, listicle, or off-topic |
| 96 | tiktok | skincare | FAIL | Current morning routine for that insane skin glow! #skincare ... | 2026-09-27 20:07 | generic routine, listicle, or off-topic |
| 97 | tiktok | amazon finds | FAIL | POV: You stumble across 7 Amazon finds that actually solve ... | 2026-09-26 19:09 | generic routine, listicle, or off-topic |
| 98 | tiktok | amazon finds | FAIL | 20 AMAZON USEFUL FINDS worth adding to your radar. This ... | 2026-09-27 19:43 | generic routine, listicle, or off-topic |
| 99 | tiktok | amazon finds | FAIL | 21 Amazon Products That Always Get Five Stars LINK IN BIO ... | 2026-09-27 17:40 | generic routine, listicle, or off-topic |
| 100 | tiktok | amazon finds | FAIL | 20 Amazon products you didn't know you needed ... | 2026-09-27 12:56 | generic routine, listicle, or off-topic |
| 101 | tiktok | amazon finds | FAIL | Amazon finds you didn't know you needed ... | 2026-09-27 06:10 | generic routine, listicle, or off-topic |
| 102 | tiktok | amazon finds | FAIL | Amazon home finds I don't regret buying ... | 2026-09-27 17:34 | generic routine, listicle, or off-topic |
| 103 | tiktok | amazon finds | FAIL | 10 things you need when you don't have enough space! Linked ... | 2026-09-27 13:47 | generic routine, listicle, or off-topic |
| 104 | tiktok | amazon finds | FAIL | some of the things I got from Amazon but full haul gon be in ... | 2026-09-27 17:10 | generic routine, listicle, or off-topic |
| 105 | tiktok | amazon finds | FAIL | amazon finds for the cool girls! Link in my bio for the store front ... | 2026-09-27 12:32 | generic routine, listicle, or off-topic |
| 106 | tiktok | amazon finds | FAIL | Amazon Tech Products You'll Wish You Bought Sooner! | 2026-09-27 07:03 | generic routine, listicle, or off-topic |
| 107 | tiktok | amazon finds | FAIL | Cute and simple #amazonfinds #amazon #cute #top #prettyGuide | 2026-09-27 17:25 | generic routine, listicle, or off-topic |
| 108 | tiktok | amazon finds | FAIL | Here's some crazy Amazon deals for September 27th! Every ... | 2026-09-27 13:32 | generic routine, listicle, or off-topic |
| 109 | tiktok | sneakers | FAIL | Sneakers from @kicksonsneakers I hope that my dad likes ... | 2026-09-27 15:15 | generic routine, listicle, or off-topic |
| 110 | tiktok | sneakers | FAIL | 5 brands to buy shoes from - #Sneakers #ShoeRotation # ... | 2026-09-27 05:44 | generic routine, listicle, or off-topic |
| 111 | tiktok | sneakers | FAIL | Sneaker Unboxing / Styling Nike Airforce 1 Triple White ... | 2026-09-27 10:54 | generic routine, listicle, or off-topic |
| 112 | tiktok | sneakers | FAIL | Nike Air Force 1 '07 Low Top Sneakers, Men's Women's White ... | 2026-09-27 05:26 | generic routine, listicle, or off-topic |
| 113 | tiktok | sneakers | FAIL | There's been a ton of sneaker releases this past week, so ... | 2026-09-27 05:01 | generic routine, listicle, or off-topic |
| 114 | tiktok | sneakers | FAIL | I love the color on these #fyp #viral #review #sneakers ... | 2026-09-27 04:33 | generic routine, listicle, or off-topic |
| 115 | tiktok | sneakers | PASS | Vans might have just made the best sneaker loafer we've seen ... | 2026-09-27 17:56 | Vans sneaker loafer: new hybrid product; not in FCT_SIGNALS |
| 116 | tiktok | sneakers | FAIL | A ton of sneaker releases dropped this past week, which ... | 2026-09-27 05:11 | generic routine, listicle, or off-topic |
| 117 | tiktok | sneakers | FAIL | White sb dunk #wholesomekicks #viral #foryou #sneakers ... | 2026-09-27 07:57 | generic routine, listicle, or off-topic |
| 118 | tiktok | sneakers | BORDER | Your everyday sneaker obsession The New Balance 530s ... | 2026-09-27 17:00 | New Balance 530: named product, but evergreen since 2023 |
| 119 | tiktok | sneakers | FAIL | Ranking Top 4 Yellow Air Jordan 4s #Jordan4 ... | 2026-09-27 23:00 | generic routine, listicle, or off-topic |
| 120 | tiktok | sneakers | FAIL | stepped out for the ootn and these are definitely still top 5 ... | 2026-09-27 08:33 | generic routine, listicle, or off-topic |
| 121 | tiktok | snack | BORDER | This Cajun Cheddar Snack Mix is crunchy, cheesy, buttery, and ... | 2026-09-27 15:00 | one creator's snack-mix recipe |
| 122 | tiktok | snack | FAIL | I love a good healthy snack. I love peanut butter. I love jelly. I lov... | 2026-09-27 20:31 | generic routine, listicle, or off-topic |
| 123 | tiktok | snack | PASS | This peanut butter popcorn is the sweet-and-salty fall snack I ... | 2026-09-25 22:39 | peanut butter popcorn as a fall snack; not in FCT_SIGNALS |
| 124 | tiktok | snack | FAIL | Evening Snack Recipe #eveningsnacksrecipe #pastry ... | 2026-09-27 05:24 | generic routine, listicle, or off-topic |
| 125 | tiktok | snack | FAIL | Healthy Snacks To Lose Weight Now, if you need a full plan ... | 2026-09-27 16:03 | generic routine, listicle, or off-topic |
| 126 | tiktok | snack | FAIL | New favorite snack alert who can guess what it is?! #tiki ... | 2026-09-27 12:17 | generic routine, listicle, or off-topic |
| 127 | tiktok | snack | FAIL | What's your go to Disneyland snack!? Have you had any of ... | 2026-09-28 01:11 | generic routine, listicle, or off-topic |
| 128 | tiktok | snack | PASS | Persian touch of rose water for a good cucumber snack! ... | 2026-09-27 04:24 | rose water on cucumber; not in FCT_SIGNALS |
| 129 | tiktok | snack | FAIL | Easy toddler meal prep for a week of never ending snack ... | 2026-09-27 09:52 | generic routine, listicle, or off-topic |
| 130 | tiktok | snack | FAIL | Just a quick little afternoon snack #snacks # ... | 2026-09-27 22:50 | generic routine, listicle, or off-topic |
| 131 | tiktok | snack | FAIL | a snack and a peace brb | 2026-09-27 21:51 | generic routine, listicle, or off-topic |
| 132 | tiktok | snack | PASS | Finally a protein snack doesn't taste like , this banana cream ... | 2026-09-27 21:11 | banana-cream protein snack; protein snack known (49 signals, 7 sources) |
| 133 | tiktok | supplement | FAIL | Pure Form® Ultra-Micronized™ Creatine helps replenish ... | 2026-09-27 13:19 | generic routine, listicle, or off-topic |
| 134 | tiktok | supplement | PASS | ‏Magnesium + B6 = the duo you want together. ... | 2026-09-27 16:19 | magnesium + B6 pairing; not in FCT_SIGNALS |
| 135 | tiktok | supplement | FAIL | This supplement stack is so powerful. You have to check with ... | 2026-09-27 23:39 | generic routine, listicle, or off-topic |
| 136 | tiktok | supplement | FAIL | Ranking the best supplements for men's health ... | 2026-09-27 17:00 | generic routine, listicle, or off-topic |
| 137 | tiktok | supplement | FAIL | Your daily defense deserves a power duo! Vitamin C + Zinc ... | 2026-09-27 05:24 | generic routine, listicle, or off-topic |
| 138 | tiktok | supplement | PASS | Magnesium glycinate liquid capsules for relaxation, sleep ... | 2026-09-27 17:37 | magnesium glycinate for sleep; known (51 signals since 2023) |
| 139 | tiktok | supplement | FAIL | You need to watch this if you're wondering what the side effects ... | 2026-09-27 08:26 | generic routine, listicle, or off-topic |
| 140 | tiktok | supplement | FAIL | Give your bones the right care it needs as you get older– ... | 2026-09-25 07:09 | generic routine, listicle, or off-topic |
| 141 | tiktok | supplement | FAIL | The Supplements men actually NEED‼ Follow for more ... | 2026-09-27 12:02 | generic routine, listicle, or off-topic |
| 142 | tiktok | supplement | FAIL | This is where I always go wrong with supplements. Which one ... | 2026-09-27 09:48 | generic routine, listicle, or off-topic |
| 143 | tiktok | supplement | BORDER | Supplements that help you sleep #blackgirlvitamins ... | 2026-09-28 03:26 | sleep supplements, brand plug |
| 144 | tiktok | supplement | BORDER | If you're taking an iron supplement, how you take it can affect ... | 2026-09-27 09:05 | iron supplement timing; known (2 signals) |
