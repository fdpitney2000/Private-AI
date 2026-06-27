# CONTEXT.md — Privacy Chat App

This file exists so anyone (including a future AI assistant or a future
you) can get oriented on this project without re-deriving decisions from
scratch. Update it whenever something here goes stale.

Last updated: 2026-06-19

---

## What this is

A privacy-first AI chat web app. No email accounts. Anonymous UID +
password generated client-side and stored only in the browser. Free tier
plus three paid monthly tiers ($50 / $100 / $200) via Stripe. The server
acts as a relay to OpenRouter and never stores prompts or responses.

## Live deployment

- **Domain:** `https://private.southwhidbey.online` (subdomain — chosen
  specifically to avoid converting the main domain's hosting type, see
  "Hosting decisions" below)
- **Host:** Hostinger Business Web Hosting, Node.js app manager
- **Server directory on host:** `~/pai` (the project folder, originally
  named `privacy-chat`, renamed to `pai` on the server)
- **Node framework preset in hPanel:** Express
- **Startup file:** `server.js`
- **Database:** Supabase (one table: `subscriptions` — see
  `supabase-setup.sql`)

## Tech stack

- Backend: Node.js + Express
- Frontend: HTML + vanilla JS (no framework, no build step)
- Payments: Stripe Checkout + webhooks
- Billing metadata storage: Supabase (service role key, server-side only)
- AI: OpenRouter (relay only, server never logs message content)

---

## Architecture, in one paragraph

Browser generates a 6-char UID + random password on first visit via
`crypto.getRandomValues()`, stored in `localStorage` only — the server
never sees real identity. Chat messages go `browser → POST /api/chat →
requireAuth middleware → OpenRouter (streamed) → browser`, with nothing
written to disk or logged along the way. Upgrades go `browser → POST
/api/billing/checkout → Stripe Checkout session (carries our generated
sub_token in metadata) → user pays on Stripe's page → Stripe sends an
async POST to /webhook/stripe → server verifies signature → writes one
row to Supabase`. The `sub_token` is the only "account" — an opaque
UUID with zero real-world identity attached.

## Folder structure

```
pai/
├── server.js                  # Express entry point
├── src/
│   ├── routes/
│   │   ├── chat.js            # OpenRouter relay (POST /api/chat, GET /api/chat/models)
│   │   ├── billing.js         # Stripe Checkout (POST /api/billing/checkout) + webhook handler
│   │   └── account.js         # GET /api/account/status, POST /api/account/recover
│   ├── middleware/
│   │   └── auth.js            # Validates sub_token, enforces plan limits + model access
│   └── services/
│       └── supabase.js        # All Supabase reads/writes (billing data only)
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js              # UID gen, chat streaming, billing, recovery — all client logic
├── .env                       # Real secrets — never committed
├── .env.example                # Template
└── supabase-setup.sql         # Run once in Supabase SQL editor
```

---

## Decisions made along the way (and why)

### Hosting: subdomain instead of converting the main domain
Hostinger's "convert site to Node.js" flow warned it would delete the
existing PHP/HTML site files **and email plan** for that domain. Avoided
entirely by creating the Node app on a subdomain
(`private.southwhidbey.online`) instead, leaving the main domain and its
email untouched. If you ever need another isolated app, same pattern:
new subdomain, not a conversion of an existing one.

### Framework preset: Express
Hostinger's Node.js setup asks for a framework preset. Chose **Express**
(the default) because `server.js` is written as a plain Express app —
not Next.js/Nuxt/etc., which expect their own build steps and file
conventions that this project doesn't use.

### RLS disabled on the Supabase `subscriptions` table
`supabase-setup.sql` explicitly runs
`ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;`. This is
intentional, not an oversight: the server talks to Supabase using the
**service role key**, which bypasses RLS regardless. There's no
Supabase Auth user in this architecture — our own Express middleware is
the only auth layer — so RLS policies would be guarding against a
client (anon-key, browser-side Supabase access) that never exists here.
**If hPanel/Supabase ever re-prompts you to enable RLS, decline, or
re-run the disable statement afterward** — enabling it with no policies
defined will silently block the server's own queries.

### Service role key vs publishable/anon key
Only the **service role key** is used (`SUPABASE_SERVICE_KEY` in
`.env`), and only inside `src/services/supabase.js`, server-side. The
publishable/anon key is not used anywhere — the browser never talks to
Supabase directly, only to our own Express server. Treat the service
key like a password: never log it, never put it in anything under
`public/`.

### APP_SECRET
Used as part of the recovery-key hashing in `billing.js`
(`hashRecoveryKey`). **Changing this value after any real recovery
key has been issued invalidates all previously issued recovery keys**
(the hash input changes, so stored hashes no longer match). Set it once,
early, with a long random value, and avoid changing it once any paid
user could plausibly have a recovery key. Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### .env value parsing (special characters)
Confirmed that `.env` parsers split on the **first** `=` only, so
values containing `=`, `/`, or `+` (common in base64/hex random output)
are preserved correctly as long as the value isn't wrapped in quotes
and has no trailing whitespace. If something seems off, verify with:
```bash
node -e "require('dotenv').config(); console.log(JSON.stringify(process.env.APP_SECRET))"
```

---

## Known issues / things that have already bitten us once

### OpenRouter free-tier model IDs need `:free` suffix
**Symptom:** `AI Service Error` in the UI, with this in server logs:
```
[chat] OpenRouter error 404: {"error":{"message":"No endpoints found for mistralai/mistral-7b-instruct.","code":404}
```
**Cause:** OpenRouter's free models require the literal `:free` suffix
in the model ID (e.g. `mistralai/mistral-7b-instruct:free`). Without it,
OpenRouter resolves to the paid route, which can 404 if there's no
active provider serving that exact bare ID.
**Fixed in:** `src/middleware/auth.js` (the `PLAN_LIMITS` model lists)
and `src/routes/chat.js` (`FREE_TIER_MODEL` constant). Also added a
one-time automatic fallback (`FALLBACK_FREE_MODEL`, currently
`meta-llama/llama-4-scout:free`) — if the primary free model 404s, the
relay retries once against the fallback before erroring out.
**This will likely recur.** OpenRouter's free model catalog changes
often — models get deprecated, renamed, or temporarily de-provisioned.
If `AI Service Error` shows up again, check the server log for the
exact OpenRouter error message first (it's logged, just not shown to
the user), then check current free models at
`https://openrouter.ai/models?max_price=0` before assuming it's
anything else (credits, auth, etc.).

### OpenRouter negative/zero credit balance
Separately from the model-ID issue above, OpenRouter requires a
non-negative balance to serve **any** request, including free models in
some cases. If credits hit $0 or below, requests get rejected before
reaching a model. Check balance at openrouter.ai/credits if errors
return and the model ID isn't the problem.

### Stripe webhook — common confusion point
Visiting `https://yourdomain.com/webhook/stripe` directly in a browser
shows nothing useful — **that's expected**. It's a POST-only route;
Stripe sends a signed server-to-server POST after a real checkout
completes. Seeing correct pricing in the upgrade modal and successfully
reaching Stripe's checkout page tests only the *session creation* half
of the flow — it does NOT confirm the webhook is wired correctly. To
actually verify the webhook:
1. Complete a real (test-mode) checkout end-to-end with card
   `4242 4242 4242 4242`
2. Check Stripe Dashboard → Developers → Webhooks → your endpoint →
   recent events. Should show `200` responses.
3. Check Supabase `subscriptions` table for a new row.
If the webhook secret in `.env` (`STRIPE_WEBHOOK_SECRET`) doesn't match
what's shown on the Stripe webhook endpoint's page, signature
verification fails and Stripe will show non-200s in its event log.

---

## Model picker: dynamic catalog (added after the :free suffix incident)

The model picker no longer hardcodes specific model IDs/versions for the
"flagship" OpenAI/Gemini/Claude options. After hitting a real 404 from a
hardcoded model ID going stale (see "Known issues" above), the picker
now fetches OpenRouter's live catalog (`GET /api/v1/models`) server-side,
cached in memory for 1 hour, and dynamically picks the newest model
matching each provider/tier pattern. Logic lives in
`src/routes/chat.js` (`pickFlagshipModels`, `pickFreeModels`,
`getModelCatalog`). A small hardcoded `STATIC_FALLBACK_FLAGSHIP` /
`STATIC_FALLBACK_FREE` list exists only as a last resort if the live
catalog fetch fails outright (network issue, OpenRouter outage) — it is
not the primary mechanism and will itself go stale over time, but it
only matters during an actual outage.

Free models are also pulled live from the same catalog rather than
maintained by hand. The frontend shows the first 2 and offers a
"show more" expander for the rest (`public/js/app.js`,
`renderModelPicker`).

Plan-based access control no longer matches against an exact static
list of allowed IDs either — it classifies any model ID into a cost
tier (`free` / `cheap` / `frontier` / `ultra`) by pattern (e.g. "haiku"
or "mini" in the slug → cheap; "opus" → ultra) and gates plans against
the tier. See `classifyModelTier` / `isPaidModelAllowed` in
`src/middleware/auth.js`. This means a brand-new model shows up in the
right plan tier automatically, without a code change, as long as its
slug follows the usual naming conventions. If a provider ships a model
with an unusual name that doesn't match any pattern, it falls through
to `frontier` (pro100+) by default — check `classifyModelTier` if a
new model ends up gated incorrectly.

### Model picker UI: no real brand logos
The model picker shows a small colored circle + letter per provider
(`.model-logo` in `style.css`) instead of actual OpenAI/Google/
Anthropic logos. This is intentional, not a placeholder oversight —
official company logos are trademarked assets, and bundling them in
the app without going through each company's brand guidelines is a
real (if narrow) legal risk. If you want real logos later: get them
from each company's official brand/press kit page, drop the files in
`public/images/logos/`, and swap the `<span class="model-logo">` for an
`<img>` tag in `providerLogoHTML()` in `app.js`.

## "No-training models only" privacy toggle

A radio toggle in the topbar lets the user restrict routing to
OpenRouter providers that don't store/train on inputs. This maps
directly to OpenRouter's per-request `provider.data_collection` field
(`"deny"` = only use providers that don't collect/train on data) — see
`callOpenRouter()` in `chat.js`. This is enforced by OpenRouter itself
at the routing layer, not by anything our server can verify — we're
trusting OpenRouter's provider data-policy metadata. If no eligible
provider exists for a given model under this restriction, the request
will 404 and the user sees "No provider matching your privacy setting
is available for this model. Try a different model."

## Minor-safe mode (`teen.html`)

A separate page, `public/teen.html`, sets `<body data-mode="minor">`,
which `app.js` checks to: hide billing/upgrade/recovery UI, hide the
privacy radio (no-train routing is forced on automatically instead),
and send `minorMode: true` with every chat request.

Server-side enforcement lives in `chat.js`:
- `isMinorSafeModel()` — restricts to closed-lab models only
  (OpenAI/Google/Anthropic prefixes), explicitly excluding all
  `:free`/open-weight models, since their built-in moderation varies
  and isn't something we can vouch for.
- A fixed `MINOR_SYSTEM_PROMPT` is force-prepended to every minor-mode
  request, and any system message the client tries to send is
  stripped first — the client cannot override this.
- `data_collection: deny` (the no-train routing above) is applied
  automatically, not just offered as an option.

**Real limitation, not a hidden one:** this app has no accounts and no
age verification — that's the whole point of the privacy model — so
"minor mode" only applies when a request explicitly carries
`minorMode: true`, which only `teen.html` sets. Nothing stops a
technically capable person from calling `POST /api/chat` directly
without that flag and bypassing all of this. Treat it as a sensible UX
default, not an age-verified or legally compliant child-safety system.
If this is ever meant for real use with actual children, COPPA-style
requirements (verified parental consent, restrictions on data
collected from minors) go well beyond what's implemented here — worth
getting real legal advice on before relying on this for that purpose.

## The "speak freely" quote — deliberately UI-only

`index.html` shows "Permission to speak freely has been granted." as a
tagline above the chat input (`.freedom-quote`). This is plain
decorative HTML — it is never sent to OpenRouter or included in the
`messages` array. That exact phrasing is a recognizable pattern used to
try to get AI models to ignore their safety training, so it was
deliberately kept out of any actual request payload. If a future
change ever considers moving text like this into a system prompt sent
to the relayed models, stop and reconsider — that crosses from "branding
copy" into "trying to get someone else's model to drop its guardrails,"
which isn't something this project should do.



- Local-only conversation memory — partially exists already
  (`app.js` stores chat history in `localStorage`, never sent to the
  server except as part of the live request)
- Local system prompts / personas — not yet built. Would mean adding a
  small settings UI that prepends a `{ role: "system", content: "..." }`
  message to the `messages` array before sending. No server changes
  needed.
- User-controlled memory clearing — already implemented ("Clear
  history" button in the UI, wired in `app.js`)

---

## Open items / things not yet verified end-to-end

- [ ] Full Stripe test-mode checkout → webhook → Supabase row, confirmed
      working (see "Stripe webhook" section above)
- [ ] Recovery key flow tested end-to-end (generate → save → simulate
      lost browser → recover)
- [ ] Confirm `requests_today` reset-at-midnight logic actually fires
      correctly in `incrementRequestCount` (the Supabase RPC fallback
      path in `supabase.js` is unverified — written defensively but
      never exercised against a real Supabase project)
- [ ] Stripe Customer Portal (`/api/billing/portal`) is a stub — not
      implemented yet
