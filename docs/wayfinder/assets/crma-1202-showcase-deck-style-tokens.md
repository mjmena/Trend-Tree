# CRMA-1202 — Showcase deck style tokens

Source: `Martin Mena_Trend Tree_filled.pptx` (repo root), 5 slides, "AI Forward Award" template. Extracted by unzipping the `.pptx` and reading the raw OOXML (`ppt/theme/theme1.xml`, `ppt/slideMasters/slideMaster1.xml`, `ppt/slideLayouts/slideLayout6.xml`, `ppt/slides/slide1-5.xml`). All 5 slides use the same layout, `slideLayout6.xml` ("BLANK").

**Key finding: the theme's scheme colors are decoration, not the real palette.** `theme1.xml`'s `<a:clrScheme name="Simple Light">` declares `accent1=#4285F4` (Google blue) and a generic Office color set — but every slide overrides fill/text color with an **explicit `<a:srgbClr>` hex value** on the shape or run itself. Some shapes (e.g. slide3's divider bar, slide5's stat cards) carry a `<p:style>` block that references `schemeClr val="accent1"`, but that reference is for the *unused* theme fill/line/effect index chain — the shape's actual `<a:solidFill>` in `<p:spPr>` wins and is always an explicit green hex. Build the HTML deck off the explicit hex values below, not the theme scheme.

## Colors

| Role | Hex | Where it comes from |
|---|---|---|
| Page background (content slides) | `#FFFFFF` | slide2/3/4/5.xml `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="ffffff"/>` |
| Title-slide background wash | `#F8FAFC`-ish pale blue-gray (flat, no gradient) | slide1.xml `<p:bg><p:bgPr><a:blipFill r:embed="rId1">` → `image1.png`, a flat pale gray-blue fill, no visible graphic |
| Primary heading / headline text | `#0F172A` (slate-900) | e.g. slide1.xml title runs "AI Forward " / " Winners"; slide2.xml "Martin Mena"; slide3/4/5.xml "The " in section headers |
| Primary accent (brand green) | `#16A34A` (Tailwind green-600) | Used pervasively: slide1.xml "Award" in the title run, slide1.xml "30 Minutes of Collective Impact", slide2.xml "AI Forward Winner:" label, slide3/4/5.xml the colored second word in "The Signal"/"The Decision"/"The Payoff", slide5.xml "Plot-Driven PTO" (trend-name callout), inline bold lead-in labels ("Real voices — ", "AI scouts — ") |
| Secondary accent (brighter green, decorative only) | `#22C55E` (Tailwind green-500) | The small vertical tick/bar mark (42120×335160 EMU, ~0.03×0.26in) placed immediately left of every section-header title on slide3/4/5.xml, e.g. slide3.xml shape id="49" |
| Divider bar accent | `#16A34A` | slide3.xml shape id="52", a thin vertical rule (45360 EMU wide) between two quote panels, with a soft drop shadow (`<a:outerShdw blurRad="39960" dist="23040">` black @ 35% alpha) |
| Secondary heading / card title text | `#1E293B` (slate-800) | slide1.xml "6 Innovators. 5 Minutes Each." |
| Body / label text (mid) | `#334155` (slate-700) | slide2.xml "Marketing Configuration Specialist", "Project: Trend Tree System" |
| Body copy inside cards | `#475569` (slate-600) | slide4.xml process-step descriptions, 160% line spacing |
| Muted / tertiary text | `#64748B` (slate-500) | slide1.xml "Followed by Audience Q&A" |
| Muted caption (custom, close to slate-500) | `#7C8A95` | slide3.xml "AI agents uncovered a collection of signals:" |
| Border / divider line | `#E2E8F0` (slate-200) | slide1.xml card border (`<a:ln w="7150"><a:solidFill><a:srgbClr val="e2e8f0"/>`), slide1.xml horizontal divider rule above the Q&A line |
| Card fill — bordered/white card | `#FFFFFF` w/ `#E2E8F0` 0.75pt border | slide1.xml roundRect id="35" (the subtitle card) |
| Card fill — borderless/tinted card | `#F3F6F8` (near-white blue-gray) | slide5.xml the 3-up "Audience / Content Gaps / Monetization" roundRect stat cards |
| Slide-number footer | `#595959` (theme `dk2`) | slideLayout6.xml `sldNum` placeholder default run color |
| Theme scheme colors (present but NOT visibly used) | dk1 `#000000`, lt1 `#FFFFFF`, dk2 `#595959`, lt2 `#EEEEEE`, accent1 `#4285F4`, accent2 `#212121`, accent3 `#78909C`, accent4 `#FFAB40`, accent5 `#0097A7`, accent6 `#EEFF41`, hlink/folHlink `#0097A7` | theme1.xml `<a:clrScheme name="Simple Light">` |

## Fonts

| Use | Family / weight | Size (pt) | Where |
|---|---|---|---|
| Deck title (title slide) | Plus Jakarta Sans ExtraBold | 39 | slide1.xml "AI Forward Award Winners" |
| Section running-header ("The Signal" / "The Decision" / "The Payoff") | Plus Jakarta Sans ExtraBold | 21 | slide3/4/5.xml, repeated verbatim pattern |
| Bio name / card headline | Plus Jakarta Sans ExtraBold | 20 | slide2.xml "Martin Mena" |
| Eyebrow/kicker label | Plus Jakarta Sans SemiBold | 11 | slide2.xml "AI Forward Winner:" |
| Process-step mini-header | Plus Jakarta Sans, bold (`b="1"` on plain "Plus Jakarta Sans", not the ExtraBold-named face) | 12 | slide4.xml "Discovery & Ingestion" / "Distillation & Promotion" / "Lifecycle" |
| Eyebrow label (title slide) | Inter, bold (`b="1"`) | 11 | slide1.xml "May Showcase" |
| Card sub-header / tagline | Inter SemiBold | 15 | slide1.xml "6 Innovators. 5 Minutes Each." |
| Card highlight statistic line | Inter ExtraBold | 19 | slide1.xml "30 Minutes of Collective Impact" |
| Pull-quote text | Inter (regular) | 20 | slide2's quote box is actually slide3.xml id="53" — the visitor quote |
| Big standalone trend-name callout | Inter, bold (`b="1"`) | 28 | slide3.xml "Plot-Driven PTO" |
| Body copy — inline labeled sentence | Inter, bold lead-in + regular continuation, same paragraph | 13 | slide3.xml "Real voices — " / "AI scouts — " prefix pattern |
| Body copy inside process cards | Inter (regular) | 9, line spacing 160% | slide4.xml step descriptions |
| Stat-card title | Inter, bold (`b="1"`) | 14 | slide5.xml "Audience" / "Content Gaps" / "Monetization" |
| Stat-card subtext | Inter (regular) | 9 | slide5.xml "who it reaches" etc. |
| Caption / muted small text | Inter (regular) | 13 | slide3.xml "AI agents uncovered a collection of signals:" |
| Icon glyphs | Material Icons (ligature font, e.g. text content `forum` renders as an icon) | 15 | slide1.xml, paired with the Q&A caption |
| Theme major/minor font (declared, essentially unused for visible text) | Arial | — | theme1.xml `<a:fontScheme name="Office">`; still the fallback in every `<a:endParaRPr>` and the slideLayout6.xml placeholder defaults |

Notes on weight naming: the deck does not consistently use the `b="1"` bold attribute to express weight — most "bold" text is actually a **named weight variant of the font family itself** (`"Plus Jakarta Sans ExtraBold"`, `"Inter SemiBold"`, `"Inter ExtraBold"`, `"Inter Medium"` all appear as literal `typeface` values, distinct from the base `"Inter"`/`"Plus Jakarta Sans"` faces). An HTML build should load Inter and Plus Jakarta Sans as variable/multi-weight webfonts and map: ExtraBold≈800, SemiBold≈600, Medium≈500, regular=400, plus occasional CSS `font-weight:700` (`b="1"`) layered on the base face where the deck did that instead (e.g. the slide4 mini-headers, slide3 trend-name callout, slide3/slide5 label lead-ins).

## Slide background treatment

- **Content slides (2, 3, 4, 5):** flat solid `#FFFFFF` page background (`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="ffffff"/>`), with a full-bleed **decorative canvas image** (`image2.png`, reused verbatim across all four) laid on top as the first shape in the tree — a large rounded-rect white/near-white panel with a hairline light-blue border and a very faint diagonal pale-green gradient wash confined to the upper-right corner. It reads as a "framed canvas" rather than a colored background; content sits inside it.
- **Title slide (1):** background is `image1.png`, a flat pale slate-gray-blue tint (no border, no gradient, no graphic elements) — essentially a tinted page, not white. A separate white rectangle shape (0,0 → full width × 1713960 EMU, ~1.87in) sits on top of the top ~1/3 to hold the eyebrow/title in a pure-white band before the tinted background shows through below.

## Accent usage in practice

- **Section-header tick mark:** every non-title-slide's running header ("The Signal", "The Decision", "The Payoff") is preceded by a small solid `#22C55E` vertical bar (~0.03in × 0.26in) positioned just left of the text baseline — a consistent, reusable "chapter marker" glyph (slide3/4/5.xml, always at the same x/y offset: title at x=707400 y=435600, tick at x=578520 y=435600).
- **Two-tone headline coloring:** section/deck titles are two runs in one paragraph — the bulk of the phrase in `#0F172A`, with exactly one word (the "payload" word — Award / Signal / Decision / Payoff) recolored `#16A34A`. Same pattern on slide1's full title ("AI Forward **Award** Winners").
- **Divider rule as accent:** a thin colored vertical bar (`#16A34A`, drop-shadowed) separates two side-by-side quote/finding panels on slide3 — accent color doubling as a structural divider, not just typography.
- **Inline labeled-sentence pattern:** body sentences open with a bold green lead-in phrase ("Real voices — ", "AI scouts — ") followed by regular dark-slate continuation text in the same paragraph — used to attribute/categorize a finding without a separate label chip.
- **Icon tinting:** the one icon glyph in the deck (Material Icons "forum") is colored in the accent green, immediately followed by muted-gray caption text — icon-as-accent, not full-color illustration.
- **Trend-name callout:** the worked-example trend name ("Plot-Driven PTO") is set large (28pt) and fully in accent green, centered, directly under a small muted caption — this is the "big reveal" moment treatment and is the one spot accent color is applied to an entire multi-word phrase rather than a single word.
- **Card borders vs. card fills:** accent green is never used as a card background; cards are either white-with-light-gray-border (`#FFFFFF` / `#E2E8F0`, slide1) or filled with a barely-tinted neutral (`#F3F6F8`, slide5) — accent stays reserved for text, rules, and the tick mark, keeping the deck predominantly neutral/white with green as a sparingly-applied signal color.

## Other reusable layout patterns

- **Canvas size:** 10in × 5.625in (9144000×5143500 EMU), 16:9.
- **Section-header position:** identical x/y across slides 3, 4, 5 (title text box at x=707400, y=435600, width 8250120 EMU ≈ 9.02in, i.e. ~0.77in left margin) — a fixed header band every content slide shares.
- **3-up card row:** slide5's "Audience / Content Gaps / Monetization" stat cards are evenly spaced rounded rectangles (roundRect, ~16.7% corner radius) each holding a bold dark-slate title (14pt) over a green subtext line (9pt) — a reusable "3 metric tiles in a row" pattern worth carrying into the HTML deck for any 3-stat summary slide.
- **Photo treatment:** the bio headshot (slide2) is square-cropped and sits inside a dashed-border placeholder frame (`image3.png`) on the pale content canvas — a soft "photo slot" affordance rather than a hard-edged photo crop.
- **Pipeline-stage cards (slide4):** three equally-spaced columns, each with a small icon strip image, a bold 12pt dark-slate mini-header, and 9pt muted body copy at 160% line spacing — directly reusable as the pattern for an HTML "pipeline stages" row.
- **Quote/finding panel (slide3):** a two-column layout (bold green lead-in + regular continuation label, then a large 20pt quote) split by the accent vertical divider bar — reusable for any "two data points side by side" slide.
