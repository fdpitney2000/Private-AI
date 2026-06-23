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

## Stage 2 (designed, not yet built)

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
