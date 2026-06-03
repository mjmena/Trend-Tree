# Trend Tree — 5-Minute Award Talk · Speaker Script

*What Marty says, slide by slide. ~4–4.5 min spoken, leaving room to breathe. Written from Marty's own first-pass ramble; trim the bracketed/optional bits to taste.*

---

**Slide 1 — "AI Forward Award Winners" (shared event card):** shown as you're introduced — no lines needed.

---

**Icebreaker — if they ask "how has AI changed your life?" at intro · ~20s**
Hello everyone — I'm Marty, marketing configuration specialist on the CRM team.

It's changed what I'm capable of at work more than at home — especially once it became a *collaborator* instead of a search tool. I know for myself having something to think out loud with lets me crystallize an idea faster and sharper than I could alone. Trend Tree — what I'm presenting today — is exactly that: a tool built faster with the aid of AI.

---

**Slide 2 — What it does + thanks · ~45s**

*(Continuous from the icebreaker — no re-greeting; bridge straight in.)*

You may have caught Jason Smith's AI Week presentation recently — the front-end dashboard, shown as a path forward. Trend Tree is the engine behind it: it's where every trend on that dashboard comes from. So let me show you how that works.

Trend Tree finds the *actionable* trends hiding in thousands upon thousands of signals. That's a scale problem — so we put agentic AI on exactly what it's good at: reading all of it, reasoning across it, and surfacing the handful that actually matter. *(Optional hook: "If you're wondering where the AI is in this — it's making every decision you're about to see.")*

Before I dive in, I want to thank a few people who've enabled our team — **Amanda Hamilton, Todd Williams, Chad Bruton, and Joe Grubbs.** On this project and so many others. Thank you for that trust that lets us keep innovating.

---

**Slide 3 — The Signal · ~40s**

Back to Trend Tree. Step one is ingesting signals. On the right is a real Bluesky post from earlier this year: someone who booked a hotel just to sit and read all weekend — room service and all. On its own? Funny. Not a trend.

But stack eleven posts like it against AI scouts independently flagging "literary tourism" elsewhere on the open web, and it stops being noise — it's a pattern. That consensus *is* the trend. And the one we're following today has been dubbed: **Plot-Driven PTO.**

---

**Slide 4 — The Decision · ~2:00**

The main question is: what are these agents actually *doing*?

First, **discovery and ingestion**. We pull raw signals from platforms like Google Trends, Bluesky, and TikTok. On top of that, we send out discovery agents to go gather raw material of their own — again, what we call signals: a spiking search, an article people are actually reading, a social post people are interacting with. But here's the key — we are *never* asking these agents "tell me what's trending right now." That's not the ask. The ask is to collect signals, so the *system* can decide what's valuable.

That decision happens in the next step — **distillation and promotion**: the thousands of signals ingested every day get combined into defined trends, like Plot-Driven PTO. The trend *is* the sum of those signals.

Once it's worth watching, it gets a **lifecycle agent**. Look at the trend line up top: discovered on the 21st — finally enough signals to call it a trend — a rise as they come in, then it cools off, quiet for a day or two. And then, just recently, a fresh spike: someone new picked it up. That's the lifecycle — measured by a number we coined the **heat index**, which moves as new signals get attributed, every change recorded.

And here's the best part of doing all this with AI: no one has to sit and research any of it. The moment the system distills a trend, it's on that dashboard — in front of a strategist, ready to act on — **within 15 minutes.** And the system never stops ingesting, so that clock is always running. There's always something new waiting for them.


---

**Slide 5 — The Payoff · ~55s**

So — what does this do for us? The best way to frame it is what's right here on the slide: every trend the system finds is a **content opportunity.** And content is where our journalists provide real value to our readers.

These early opportunities let us get ahead of trends and prepare for them — by asking: who's the **audience** this reaches, and do we already serve them? Have we covered this trend already but **missed an angle** worth revisiting? And — obviously — **monetization** is always there: are there sponsors who'd want to be associated with this trend?

That's what we're building right now — and that's just one trend. There are **209 more live**, each one a story we could tell first. Thank you.

---

## Notes

- **Timing:** ~4–4.5 min spoken — comfortable inside 5. If you run long, the easiest trim is the heat-line play-by-play on Slide 4 (keep "discovered → cooled → spiked again," cut the detail).
- **Accuracy flag (Slide 4):** you said the recent spike came from TikTok; the ledger just shows "new signals" (source unconfirmed), so I kept it vague — *"someone new picked it up."* Say the word and I'll verify the source so you can name TikTok if it's real.
- **First Q&A question** ("where's the instance of AI?"): answered by your open + the whole walk — the system makes the calls, no human in the loop. The optional hook on Slide 2 preempts it.
- Verified data + Q&A backstop (cost, model, scale numbers) live in `presentation-throughline-plot-driven-pto.md` if you get technical questions.
