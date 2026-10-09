# 3rike Pay — demo film script

**Runtime 1:29.50** (89.50s) · 16 lines · 199 spoken words · 164.3 wpm · 1920×1080 @ 30fps

Voice: Kokoro `am_michael` at speed 0.88, slow enough to be followed on
first hearing, with phoneme overrides so the product is called THREE-rike (not
"three-REE-kay") and *naira* rhymes with *fire*. Word timings come from Parakeet
and pin every visual beat; `build/cues.js` throws if a beat names a word the
voice never said.

## Scenes

- **The problem** — 0.85s → 15.55s (14.70s), l01–l03
- **The name** — 18.01s → 26.34s (8.32s), l04–l05
- **Part one — sending money (Nigeria)** — 27.73s → 53.91s (26.18s), l06–l10
- **Part two — getting paid (Rwanda)** — 55.30s → 78.73s (23.43s), l11–l15
- **Sign-off** — 80.12s → 86.80s (6.68s), l16–l16

## Lines

| id | start | len | spoken | source |
|----|------:|----:|--------|--------|
| `l01` |   0.85 | 4.59 | You agree a price in a WhatsApp chat. Then you leave the chat to pay. | Framing. No product claim. |
| `l02` |   5.97 | 3.11 | The bank app. The password. Waiting for the code. | Framing. No product claim. |
| `l03` |   9.62 | 5.93 | Then back here with a screenshot, to prove it. The deal is here. The money is elsewhere. | Framing. No product claim. |
| `l04` |  18.01 | 1.39 | 3rike Pay. | Brand name. |
| `l05` |  20.68 | 5.65 | A bank that lives inside WhatsApp. You message it, the way you message a friend. | Whole product: a WhatsApp bot. Site headline 'Your bank lives in your chats.' |
| `l06` |  27.73 | 6.66 | Verify your ID once, choose a PIN, and the bot hands you a real account number. | docs.ts §3 setup steps: choose ID -> SMS code -> 4-digit PIN -> 'a real account number other people can pay into by ordinary bank transfer'. |
| `l07` |  34.92 | 3.52 | To send, you type it the way you would say it out loud. | Site hero chat, verbatim: 'Send 5k to 1234567890 GTBank'; docs §6. |
| `l08` |  38.97 | 5.46 | Five k. One milla. Four thousand in words. It understands all three. | src/utils/helpers.ts expandAmountShorthand + wordsToNumber; docs §6. |
| `l09` |  44.97 | 4.86 | It shows the name on the account first, so you can check before you send. | messages.json SEND_MONEY.CONFIRM — name enquiry before debit; docs §6. |
| `l10` |  50.37 | 3.54 | Your PIN, and it is gone — with a receipt and a reference. | messages.json SEND_MONEY.SUCCESS (reference); src/utils/pin.ts stores a bcrypt hash, so the PIN cannot be read back. |
| `l11` |  55.30 | 4.63 | The same account is also your shop. Nothing new to sign up for. | One user record carries both sides; docs §1 'One account does both', §15. |
| `l12` |  60.47 | 4.84 | Type slash invoice and what they bought. It already knows your prices. | messages.json BUSINESS.INVOICE.PROMPT_ITEMS + BUSINESS.PRODUCT.*; docs §8, §9. |
| `l13` |  65.84 | 4.82 | Your customer approves a prompt on their phone. That is their whole side. | messages.json BUSINESS.INVOICE.ISSUED_PUSH; docs §10 — the customer approves a mobile-money prompt and never messages the bot. |
| `l14` |  71.20 | 2.60 | No app, no link, no account with us. | docs §10 — the customer approves a mobile-money prompt on their own phone; the bot never messages them and they never hold an account here. |
| `l15` |  74.34 | 4.39 | And you see every fee. On a hundred francs, you keep eighty nine. | docs §12 ledger: RWF 100 − 5.00 platform − 5.92 processor = 89.08, itemised on every settled payment. |
| `l16` |  80.12 | 6.68 | 3rike Pay. Rwanda and Nigeria — inside the conversation you were already having. | Rwanda: invoicing. Nigeria: transfers. Both live. |

## Pacing

Lead-in 0.85s · tail 2.7s · gap unit 0.535s.
Pauses are solved, not typed: `tools/place.py` weights each gap (1.0 inside a
scene, 2.6 at a picture change, 4.6 before the name) and scales the set to land
the whole film on 89.50s. Within-scene breath is 0.54s, a picture change
1.39s, and the beat before "3rike Pay" is 2.46s so the music can arrive
under it.

## Shown, not spoken

Five facts are carried by the picture alone, because the script has no room
for them and they are what a careful viewer wants to know. Each one is a
caption over the beat it belongs to.

| On screen | Where it comes from |
|---|---|
| Anyone can pay it by ordinary bank transfer | `web/src/data/docs.ts:251` — “anyone can pay you by ordinary bank transfer” |
| ₦100 to ₦1,000,000 in one transfer | `src/config/constants.ts:215,217` (`MIN_TRANSFER`, `MAX_TRANSFER`) |
| 3 wrong tries locks transfers for 15 minutes | `src/api/transferFlow.ts:17-18` |
| The request expires in 30 minutes | `src/services/invoice.ts:34` (`INVOICE_TTL_MINUTES = 30`) |
| Approved with MTN, Airtel or KTRN mobile money | `src/services/invoice.ts:335` |

## What the film shows

Every chat frame is a real capture of the live site at 3rike-pay.vercel.app —
the hero's own WhatsApp panel and the transcripts the documentation renders
from the bot's actual message templates. They are revealed and cropped, never
redrawn. The one annotation drawn over a capture is the ring around the message
composer, which frames the product's own pixels without covering them.

The only invented frames are the opening three bubbles — a generic haggle that
makes no claim about the product — and the typographic beats.

Nothing in the film is addressed to engineers: there is no code, no test count
and no vocabulary a customer would have to look up.

## Sound

The score is original, generated by `tools/score.py` from the cue times, so
nothing in this repository carries a third party's licence and no attribution
is owed. A low D minor pad and a slow tick under the problem; a riser that
resolves onto a D major bell struck exactly on the spoken word "3rike" at
18.01s; then a light kalimba groove in D at 96 BPM — plucked tines, a
soft shaker on the offbeats and a short bass note on the downbeat — which
stops dead for the sign-off.

The groove is written to be heard between the lines and barely at all beneath
one. `tools/mix.py` holds it at 0.72 of the voice and ducks it a further 20 dB
whenever a word is being spoken, with 150 ms of look-ahead so it is already out
of the way before a line starts: in the delivered master it sits about 12 dB
under the narration in the gaps and about 32 dB under it during a line.

`tools/loudness.sh` then compresses, applies a flat measured gain and
brickwalls the transients. Two-pass loudnorm is the usual recipe and is wrong
here: the mix has a ~20 dB crest factor, so the gain needed to reach -14 LUFS
always pushes the true peak past the ceiling and loudnorm silently abandons
linear mode. The delivered master measures **-14.6 LUFS, -1.6 dBTP**.
