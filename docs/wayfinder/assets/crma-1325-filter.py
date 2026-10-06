import json, re, subprocess, urllib.request, sys
items = json.load(open("results.json"))
key = subprocess.check_output(["security","find-generic-password","-s","gemini-api","-w"]).decode().strip()

# Filter R: regex. Drops listicles, routines, hauls, rankings, generic "finds".
R = re.compile(r"(\b\d+\s+(things|products|amazon|brands|finds|items|must|best|snacks|supplements)\b|routine|haul|\bfinds\b|ranking|top \d|\bbest\b|you didn.t know|link in bio|what.s your|#fyp\s*$)", re.I)

PROMPT = """You screen short-video search results for a consumer-trends pipeline.
KEEP a result only if its title and snippet name a SPECIFIC product, ingredient,
or practice that a consumer is doing: "a noun phrase you can put on a slide and a
verb a consumer is doing". Good: "Cottage cheese as high-protein snack", "Mouth
taping for sleep", "Sleepy girl mocktail (tart cherry + magnesium)".
DROP: categories ("skincare", "supplements"), generic routines, listicles
("20 Amazon finds"), hauls, rankings, unboxings of a long-established product,
brand ads, deal posts, and posts with no nameable product or practice.
Return JSON: a list of {"i": <index>, "keep": true|false, "phrase": "<the noun phrase, or empty>"}.
Results:
"""
def gemini(batch):
    body = PROMPT + "\n".join(f'{i}. {it["title"]} | {it.get("snippet") or ""}' for i, it in batch)
    req = dict(contents=[{"parts":[{"text":body}]}], generationConfig={"responseMimeType":"application/json","temperature":0})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key={key}"
    r = json.load(urllib.request.urlopen(urllib.request.Request(url, json.dumps(req).encode(), {"Content-Type":"application/json"}), timeout=120))
    return json.loads(r["candidates"][0]["content"]["parts"][0]["text"]), r.get("usageMetadata", {})
idx = list(enumerate(items))
usage = []
for k in range(0, len(idx), 40):
    out, u = gemini(idx[k:k+40]); usage.append(u)
    for o in out:
        items[o["i"]]["llm_keep"] = bool(o["keep"]); items[o["i"]]["llm_phrase"] = o.get("phrase","")
for it in items:
    it["regex_keep"] = not R.search((it["title"] or "") + " " + (it.get("snippet") or ""))
json.dump(items, open("filtered.json","w"), indent=1)
json.dump(usage, open("filter_usage.json","w"))
print("llm keep", sum(i.get("llm_keep",False) for i in items), "regex keep", sum(i["regex_keep"] for i in items), "of", len(items)); print(usage)
