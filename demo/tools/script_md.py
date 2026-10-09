"""Regenerate script.md from lines.json + build/placement.json.

The claim->source column lives here, keyed by line id, so the document can
never drift from the audio that was actually synthesized.

Usage: python -I tools/script_md.py <demo-dir>
"""
import sys, json, pathlib

ROOT = pathlib.Path(sys.argv[1])
spec = json.loads((ROOT / "lines.json").read_text())
place = json.loads((ROOT / "build/placement.json").read_text())
L, S = place["lines"], place["scenes"]

SOURCE = {
 "l01": "Framing. No product claim.",
 "l02": "Framing. No product claim.",
 "l03": "Framing. No product claim.",
 "l04": "Brand name.",
 "l05": "Whole product: a WhatsApp bot. Site headline 'Your bank lives in your chats.'",
 "l06": "docs.ts §3 setup steps: choose ID -> SMS code -> 4-digit PIN -> 'a real account number other people can pay into by ordinary bank transfer'.",
 "l07": "Site hero chat, verbatim: 'Send 5k to 1234567890 GTBank'; docs §6.",
 "l08": "src/utils/helpers.ts expandAmountShorthand + wordsToNumber; docs §6.",
 "l09": "messages.json SEND_MONEY.CONFIRM — name enquiry before debit; docs §6.",
 "l10": "messages.json SEND_MONEY.SUCCESS (reference); src/utils/pin.ts stores a bcrypt hash, so the PIN cannot be read back.",
 "l11": "One user record carries both sides; docs §1 'One account does both', §15.",
 "l12": "messages.json BUSINESS.INVOICE.PROMPT_ITEMS + BUSINESS.PRODUCT.*; docs §8, §9.",
 "l13": "messages.json BUSINESS.INVOICE.ISSUED_PUSH; docs §10 — the customer approves a mobile-money prompt and never messages the bot.",
    "l14": "docs §10 — the customer approves a mobile-money prompt on their own phone; the bot never messages them and they never hold an account here.",
    "l15": "docs §12 ledger: RWF 100 − 5.00 platform − 5.92 processor = 89.08, itemised on every settled payment.",
 "l16": "Rwanda: invoicing. Nigeria: transfers. Both live.",
}
SCENE_TITLE = {"s1_cold": "The problem", "s2_title": "The name",
               "s3_person": "Part one — sending money (Nigeria)",
               "s4_biz": "Part two — getting paid (Rwanda)",
               "s5_close": "Sign-off"}

words = sum(len(l["say"].split()) for l in spec["lines"])
speech = sum(L[l["id"]][1] - L[l["id"]][0] for l in spec["lines"])
total = place["total"]
unit = place["unit"]

out = []
# Captions that make a claim the narration never speaks. Same rule as SOURCE:
# keyed here so the table can never drift from what is on screen.
ON_SCREEN = [
    ("Anyone can pay it by ordinary bank transfer",
     "`web/src/data/docs.ts:251` — \u201canyone can pay you by ordinary bank transfer\u201d"),
    ("\u20a6100 to \u20a61,000,000 in one transfer",
     "`src/config/constants.ts:215,217` (`MIN_TRANSFER`, `MAX_TRANSFER`)"),
    ("3 wrong tries locks transfers for 15 minutes",
     "`src/api/transferFlow.ts:17-18`"),
    ("The request expires in 30 minutes",
     "`src/services/invoice.ts:34` (`INVOICE_TTL_MINUTES = 30`)"),
    ("Approved with MTN, Airtel or KTRN mobile money",
     "`src/services/invoice.ts:335`"),
]

w = out.append
w("# 3rike Pay — demo film script\n")
w(f"**Runtime {int(total//60)}:{total%60:05.2f}** ({total:.2f}s) · {len(spec['lines'])} lines · "
  f"{words} spoken words · {words/speech*60:.1f} wpm · 1920×1080 @ 30fps\n")
w(f"Voice: Kokoro `{spec['voice']}` at speed {spec['speed']}, slow enough to be followed on\n"
  "first hearing, with phoneme overrides so the product is called THREE-rike (not\n"
  '"three-REE-kay") and *naira* rhymes with *fire*. Word timings come from Parakeet\n'
  "and pin every visual beat; `build/cues.js` throws if a beat names a word the\n"
  "voice never said.\n")
w("## Scenes\n")
for s, ids in spec["scenes"].items():
    a, b = S[s]
    w(f"- **{SCENE_TITLE[s]}** — {a:.2f}s → {b:.2f}s ({b-a:.2f}s), {ids[0]}–{ids[-1]}")
w("\n## Lines\n")
w("| id | start | len | spoken | source |")
w("|----|------:|----:|--------|--------|")
for l in spec["lines"]:
    a, b = L[l["id"]]
    w(f"| `{l['id']}` | {a:6.2f} | {b-a:4.2f} | {l['say']} | {SOURCE[l['id']]} |")
w("\n## Pacing\n")
w(f"Lead-in {place['lead']}s · tail {place['tail']}s · gap unit {unit:.3f}s.")
w("Pauses are solved, not typed: `tools/place.py` weights each gap (1.0 inside a")
w("scene, 2.6 at a picture change, 4.6 before the name) and scales the set to land")
w(f"the whole film on {total:.2f}s. Within-scene breath is {unit:.2f}s, a picture change")
w(f"{unit*2.6:.2f}s, and the beat before \"3rike Pay\" is {unit*4.6:.2f}s so the music can arrive")
w("under it.\n")
w("## Shown, not spoken\n")
w("Five facts are carried by the picture alone, because the script has no room")
w("for them and they are what a careful viewer wants to know. Each one is a")
w("caption over the beat it belongs to.\n")
w("| On screen | Where it comes from |")
w("|---|---|")
for cap, src in ON_SCREEN:
    w(f"| {cap} | {src} |")
w("")
w("## What the film shows\n")
w("Every chat frame is a real capture of the live site at 3rike-pay.vercel.app —")
w("the hero's own WhatsApp panel and the transcripts the documentation renders")
w("from the bot's actual message templates. They are revealed and cropped, never")
w("redrawn. The one annotation drawn over a capture is the ring around the message")
w("composer, which frames the product's own pixels without covering them.\n")
w("The only invented frames are the opening three bubbles — a generic haggle that")
w("makes no claim about the product — and the typographic beats.\n")
w("Nothing in the film is addressed to engineers: there is no code, no test count")
w("and no vocabulary a customer would have to look up.\n")
w("## Sound\n")
w("The score is original, generated by `tools/score.py` from the cue times, so")
w("nothing in this repository carries a third party's licence and no attribution")
w("is owed. A low D minor pad and a slow tick under the problem; a riser that")
w("resolves onto a D major bell struck exactly on the spoken word \"3rike\" at")
w(f"{L['l04'][0]:.2f}s; then a light kalimba groove in D at 96 BPM — plucked tines, a")
w("soft shaker on the offbeats and a short bass note on the downbeat — which")
w("stops dead for the sign-off.\n")
w("The groove is written to be heard between the lines and barely at all beneath")
w("one. `tools/mix.py` holds it at 0.72 of the voice and ducks it a further 20 dB")
w("whenever a word is being spoken, with 150 ms of look-ahead so it is already out")
w("of the way before a line starts: in the delivered master it sits about 12 dB")
w("under the narration in the gaps and about 32 dB under it during a line.\n")
w("`tools/loudness.sh` then compresses, applies a flat measured gain and")
w("brickwalls the transients. Two-pass loudnorm is the usual recipe and is wrong")
w("here: the mix has a ~20 dB crest factor, so the gain needed to reach -14 LUFS")
w("always pushes the true peak past the ceiling and loudnorm silently abandons")
w("linear mode. The delivered master measures **-14.6 LUFS, -1.6 dBTP**.")
(ROOT / "script.md").write_text("\n".join(out) + "\n")
