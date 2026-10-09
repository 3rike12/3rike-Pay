# 3rike Pay — demo film brief

## What it is
A payment service that lives entirely inside WhatsApp. No app, no website login.
You message a number; it answers. Two halves on one account:

- **Personal (Nigeria, NGN)** — send money to any bank account on the NIP network.
- **Business (Rwanda, RWF)** — raise a payment request, collected over mobile money.

## Who it is for
People and small merchants in Nigeria and Rwanda who already do business in a
WhatsApp thread, and currently have to leave it to move the money.

## The one problem it solves
The deal happens in the chat. The money happens somewhere else — a bank app, a
password, a one-time code, and a screenshot sent back as proof. 3rike Pay
closes that gap: the money moves in the same thread as the conversation.

## What is proven (every claim in the script maps here)
| Claim | Source |
|---|---|
| No app/website; WhatsApp only | Whole product; `src/bot/index.ts` |
| NIN or BVN + SMS code + 4-digit PIN | Manual §3; `src/api/` KYC flow |
| You are issued a real bank account number | Manual §3 |
| Reads "5k", "1 milla", "four thousand" | `src/utils/helpers.ts:152-175` (`expandAmountShorthand`, `wordsToNumber`) |
| Shows the recipient's real name before sending | `src/bot/index.ts` name resolution; manual §6 |
| ₦100 minimum, ₦1,000,000 maximum per transfer | `src/config/constants.ts:215,217`; enforced `src/bot/index.ts:1096-1101` |
| One account is both customer and merchant | Manual §1 "One account does both" |
| Invoice fills prices from your catalogue | `src/services/invoice.ts`; manual §9 |
| Rwanda mobile money: MTN, Airtel, KTRN | `tests/nl.test.ts:24`; `src/services/invoice.ts:335` |
| Customer approves a push prompt; bot never messages them | Manual §10 |
| 5% platform fee | `src/config/constants.ts:207` (`SPLIT_VALUE 0.95`) |
| RWF 100 → fee 5.00, processor 5.92, keep 89.08 | Manual §12 (p14) |
| 3 wrong PINs → 15-minute lockout | `src/api/transferFlow.ts:17-18` (`MAX_PIN_ATTEMPTS`, `LOCKOUT_MINUTES`) |
| Payment requests expire after 30 minutes | `src/services/invoice.ts:34` (`INVOICE_TTL_MINUTES = 30`) |
| Anyone can pay your account by ordinary bank transfer | `web/src/data/docs.ts:251` |
| Live at 3rike-pay.vercel.app | Deployed this session |

The last five are **captions, not narration** — the script has no room for them
and they are what a careful viewer wants to know. `script.md` lists them under
"Shown, not spoken" with the same claim→source discipline.

## Deliberately NOT claimed
- Airtime and data (behind `BUY_AIRTIME.COMING_SOON` — not live)
- Any user-count, volume or growth statistic (none verifiable)
- Nigerian invoicing (invoicing is Rwanda-only today)
- Instant/"in seconds" settlement timing (not measured)

## Target
**1:29.50.** 16 lines, 199 spoken words at 164.2 wpm, 1920x1080 @ 30fps.
(The first cut ran 3:16; it was re-cut to come in under 1:30. The voice was
then slowed from 0.97 to 0.88 — 176 to 162 wpm — because the brief asks for
"very understandable" before it asks for anything else. The depth that bought
back went into the picture, where it costs no seconds.)

## Where the pictures come from
Nothing on screen is a mockup of the product.

| On screen | Provenance |
|---|---|
| Hero page, full frame | Playwright capture of `https://3rike-pay.vercel.app/` |
| WhatsApp panel, one-shot command | The hero's own chat component, captured after its animation settles |
| Account-ready, transfer, catalogue, invoice, receipt, fee ledger | Element captures of `/doc/*`, which render the bot's real message templates from `src/config/messages.json` |
| Account-ready card, confirmation, receipt, catalogue, invoice, payment request, fee ledger | Element captures of `/doc/*`, cropped to the exact bubble using the per-bubble geometry recorded in `assets/shots/shots.json` |

Captures are **revealed and cropped**, never redrawn: the reveal boxes grow over
a fixed screenshot, so every pixel of product UI is the product's own. The site's
fixed header is suppressed before element captures, or it lands on top of them.

The only invented frames are the three opening bubbles — a generic haggle that
makes no claim about the product — the deliberately grey "transfer successful"
receipt that stands for the screenshot people send as proof, and the
typographic beats ("The deal is here / The money is elsewhere", the amount
chips, the three "No app / No link / No account" slabs, the closing card).

The grey receipt is drawn rather than captured on purpose: using this product's
own UI to illustrate *the old way* would have been the one genuinely misleading
frame in the film.

Nothing in the film is addressed to engineers. There is no code, no test count,
and no word a customer would have to look up.

## Sound
The score is **original**, generated deterministically by `tools/score.py` from
the cue sheet, so nothing in this repository carries a third party's licence and
no attribution is owed. D minor under the problem, resolving to a D major bell
struck on the spoken word "3rike" at 18.00s, then a light kalimba groove in D at
96 BPM through both halves, stopping dead for the sign-off.

It is mixed to be heard *between* lines and barely at all beneath one: held at
0.72 of the voice and ducked a further 20 dB whenever a word is being spoken,
with 150 ms of look-ahead. In the master it sits about 12 dB under the narration
in the gaps and about 32 dB under it during a line. Measured **-14.6 LUFS,
-1.6 dBTP**.

## Known inconsistency, flagged not hidden
The Fees page on the site shows RWF 3,000 -> -150 -> -158.03 -> **2,691.97**
(a 5.27% processor rate) while docs SS12 and the manual show RWF 100 -> -5.00 ->
-5.92 -> **89.08** (5.92%). Both are presented as real settled transactions and
they cannot both be the current processor rate. The film uses the RWF 100
figures because the documentation states them as the exact amounts behind a
rounded chat message. **Someone should reconcile the two before this ships.**
