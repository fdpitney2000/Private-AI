// src/routes/chat.js
// ==================
// This is the most privacy-critical file in the app.
// It acts as a relay between the browser and OpenRouter.
//
// WHAT THIS FILE DOES:
//   - Receives the user's messages from the browser
//   - Validates their subscription (via middleware)
//   - Forwards the messages to OpenRouter
//   - Streams the response back to the browser
//   - NEVER stores prompts, responses, or conversation content
//
// WHAT THIS FILE DOES NOT DO:
//   - Log message content
//   - Save conversations to a database
//   - Store anything about what the user asked
//
// WHAT'S NEW IN THIS VERSION:
//   - The model picker is populated dynamically from OpenRouter's live
//     catalog (GET /api/v1/models) instead of a hardcoded list. This is
//     deliberate: hardcoded model IDs go stale (see CONTEXT.md — we hit
//     this exact bug once already with a 404 on a renamed free model).
//     The catalog is cached in memory for CATALOG_TTL_MS to avoid
//     hitting OpenRouter on every page load.
//   - Per-request "no train on my inputs" support via OpenRouter's
//     provider.data_collection field.
//   - "Minor mode" support: when the client flags a request as
//     minor-safe, the server enforces a restricted model allowlist and
//     force-injects a safety system prompt — the client cannot override
//     either of these by sending different values.
//
//   IMPORTANT LIMITATION (read this before relying on minor mode):
//   This server has no concept of accounts or verified age — that's the
//   whole privacy model of the app. "Minor mode" only applies when a
//   request explicitly sets minorMode: true (which is what the separate
//   teen.html page does). A technically capable person could still call
//   POST /api/chat directly without that flag and bypass the
//   restriction entirely. This is a UX-level safeguard, not an
//   age-verified guarantee. See CONTEXT.md for more on this.

'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth, classifyModelTier, isPaidModelAllowed } = require('../middleware/auth');

// Default model for free tier users.
// IMPORTANT: must include ":free" suffix or OpenRouter routes to the
// paid endpoint, which can 404 if there's no active route / no credit.
const FREE_TIER_MODEL = 'mistralai/mistral-7b-instruct:free';

// Fallback model if the primary free model is down. OpenRouter's free
// catalog changes often — see https://openrouter.ai/models?max_price=0
const FALLBACK_FREE_MODEL = 'meta-llama/llama-4-scout:free';

// -------------------------------------------------------
// Minor-safe mode configuration
// -------------------------------------------------------
// Only closed, frontier-lab models are considered "minor safe" here —
// open-weight / community / free models are excluded because their
// built-in moderation varies widely and isn't something we can vouch
// for. This is a deliberately conservative allowlist, not a claim that
// every other model is unsafe.
function isMinorSafeModel(modelId) {
  if (!modelId) return false;
  if (modelId.endsWith(':free')) return false;
  return (
    modelId.startsWith('openai/') ||
    modelId.startsWith('google/gemini') ||
    modelId.startsWith('anthropic/claude')
  );
}

// A safe, cheap default to fall back to in minor mode if the requested
// model isn't on the allowlist. Verified against OpenRouter's live
// catalog at request time in getDefaultMinorModel() below, with this
// as the last-resort hardcoded fallback if that lookup fails.
const HARDCODED_MINOR_FALLBACK = 'anthropic/claude-3-5-haiku';

// This system prompt is force-injected server-side for every minor-mode
// request. The client cannot remove or override it — we strip any
// system message the client sends and replace it with this one.
const MINOR_SYSTEM_PROMPT = {
  role: 'system',
  content:
    'You are chatting with a young person under 18. Keep every response ' +
    'friendly, encouraging, and age-appropriate. Do not discuss violence, ' +
    'sexual content, profanity, illegal activity, self-harm, or other ' +
    'mature themes. If asked about something sensitive or dangerous, ' +
    'gently decline and suggest they talk to a parent, guardian, or ' +
    'other trusted adult.',
};

// -------------------------------------------------------
// OpenRouter model catalog cache
// -------------------------------------------------------
// We fetch OpenRouter's full model list once per CATALOG_TTL_MS and
// reuse it, rather than calling /api/v1/models on every page load.
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour
let catalogCache = { data: null, fetchedAt: 0 };

// How long to wait for OpenRouter's /models endpoint before giving up
// and falling back to the static list. Without this, a slow/stalled
// response from OpenRouter would hang the request indefinitely instead
// of failing — which is exactly what "Loading models..." forever looks
// like to the user.
const CATALOG_FETCH_TIMEOUT_MS = 8000;

async function getModelCatalog() {
  const now = Date.now();
  if (catalogCache.data && (now - catalogCache.fetchedAt) < CATALOG_TTL_MS) {
    console.log(`[chat/models] Using cached catalog (${catalogCache.data.length} models, age ${Math.round((now - catalogCache.fetchedAt) / 1000)}s)`);
    return catalogCache.data;
  }

  console.log('[chat/models] Cache miss/expired — fetching live catalog from OpenRouter…');

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`OpenRouter /models fetch timed out after ${CATALOG_FETCH_TIMEOUT_MS}ms`);
    }
    throw err; // network error, DNS failure, etc — rethrow as-is
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    throw new Error(`OpenRouter /models fetch failed: ${resp.status}`);
  }

  const json = await resp.json();
  catalogCache = { data: json.data || [], fetchedAt: now };
  console.log(`[chat/models] Fetched live catalog: ${catalogCache.data.length} models`);
  return catalogCache.data;
}

// Pick the newest model in a list by OpenRouter's `created` timestamp.
function newest(models) {
  if (!models.length) return null;
  return models.slice().sort((a, b) => (b.created || 0) - (a.created || 0))[0];
}

// -------------------------------------------------------
// Dynamically determine "latest flagship" models per provider.
// This replaces hardcoding exact version numbers (gpt-5.2,
// claude-opus-4.8, etc) which go stale within weeks. Instead we find
// the newest model matching each provider/tier's ID pattern, live,
// every time the cache refreshes.
// -------------------------------------------------------
function pickFlagshipModels(catalog) {
  const openaiChat = catalog.filter(m =>
    m.id.startsWith('openai/gpt-') &&
    !m.id.includes('oss') &&     // exclude open-weight gpt-oss variants
    !m.id.includes('image') &&   // exclude image-generation models
    !m.id.endsWith(':free')
  );
  const geminiChat = catalog.filter(m =>
    m.id.startsWith('google/gemini-') &&
    !m.id.includes('image') &&
    !m.id.endsWith(':free')
  );
  const claudeOpus   = catalog.filter(m => m.id.startsWith('anthropic/claude-opus-'));
  const claudeSonnet = catalog.filter(m => m.id.startsWith('anthropic/claude-sonnet-'));
  const claudeHaiku  = catalog.filter(m => m.id.includes('claude') && m.id.includes('haiku'));

  const out = [];
  const o  = newest(openaiChat);    if (o)  out.push({ id: o.id,  name: o.name  || o.id,  provider: 'openai',    tierLabel: 'OpenAI'       });
  const g  = newest(geminiChat);    if (g)  out.push({ id: g.id,  name: g.name  || g.id,  provider: 'google',    tierLabel: 'Gemini'       });
  const cs = newest(claudeSonnet);  if (cs) out.push({ id: cs.id, name: cs.name || cs.id, provider: 'anthropic', tierLabel: 'Claude Sonnet' });
  const co = newest(claudeOpus);    if (co) out.push({ id: co.id, name: co.name || co.id, provider: 'anthropic', tierLabel: 'Claude Opus'   });
  const ch = newest(claudeHaiku);   if (ch) out.push({ id: ch.id, name: ch.name || ch.id, provider: 'anthropic', tierLabel: 'Claude Haiku' });

  return out;
}

// Pull every free model (':free' suffix or zero prompt price) out of
// the live catalog, newest first.
function pickFreeModels(catalog) {
  return catalog
    .filter(m => m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0))
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, name: m.name || m.id }));
}

// Find the newest minor-safe model in the catalog, for use as the
// minor-mode default instead of a hardcoded ID.
function getDefaultMinorModel(catalog) {
  const safe = catalog.filter(m => isMinorSafeModel(m.id) && /haiku|mini|flash/i.test(m.id));
  const pick = newest(safe);
  return pick ? pick.id : HARDCODED_MINOR_FALLBACK;
}

// Static fallback shown only if the live OpenRouter catalog fetch fails
// entirely (network issue, OpenRouter outage, etc). Kept intentionally
// small — its only job is to keep the app usable, not to be current.
const STATIC_FALLBACK_FLAGSHIP = [
  { id: 'openai/gpt-5.2',              name: 'GPT-5.2',            provider: 'openai',    tierLabel: 'OpenAI'        },
  { id: 'google/gemini-3-pro',         name: 'Gemini 3 Pro',       provider: 'google',    tierLabel: 'Gemini'        },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6',  provider: 'anthropic', tierLabel: 'Claude Sonnet' },
  { id: 'anthropic/claude-opus-4.8',   name: 'Claude Opus 4.8',    provider: 'anthropic', tierLabel: 'Claude Opus'   },
];
const STATIC_FALLBACK_FREE = [
  { id: 'mistralai/mistral-7b-instruct:free', name: 'Mistral 7B (Free)' },
  { id: 'meta-llama/llama-4-scout:free',      name: 'Llama 4 Scout (Free)' },
];

// -------------------------------------------------------
// Helper: call the OpenRouter chat completions endpoint
// -------------------------------------------------------
// `providerPrefs` lets callers attach OpenRouter's provider routing
// object — used for the "no training on my inputs" privacy toggle.
async function callOpenRouter(model, messages, providerPrefs) {
  const body = {
    model:      model,
    messages:   messages,
    stream:     true,   // Stream tokens as they're generated
    max_tokens: 2048,
  };

  if (providerPrefs) {
    body.provider = providerPrefs;
  }

  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization':    `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type':     'application/json',
      // OpenRouter optionally uses HTTP-Referer for analytics.
      // Using a generic label keeps users anonymous there too.
      'HTTP-Referer':     process.env.APP_URL || 'http://localhost:3000',
      'X-Title':          'Privacy Chat App',
    },
    body: JSON.stringify(body),
  });
}

// -------------------------------------------------------
// POST /api/chat
// -------------------------------------------------------
// Body: {
//   messages: [...],
//   model: "model-id",
//   noTrainOnly: boolean,   // restrict routing to providers that don't train on inputs
//   minorMode: boolean,     // enforce minor-safe model allowlist + forced system prompt
// }
//
// The browser is responsible for maintaining conversation history
// in localStorage. The server sees all messages each time but
// logs none of them.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { messages: rawMessages, model: requestedModel, noTrainOnly, minorMode } = req.body;

    // ---- Validate inputs ----
    if (!rawMessages || !Array.isArray(rawMessages) || rawMessages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }

    // Enforce message count limit to prevent abuse
    if (rawMessages.length > 100) {
      return res.status(400).json({ error: 'Too many messages in context (max 100).' });
    }

    let messages = rawMessages;
    let model    = requestedModel || FREE_TIER_MODEL;

    // ---- Minor mode: enforce allowlist + forced system prompt server-side ----
    // The client cannot bypass this by sending a different model or by
    // including its own system message — both are overridden here.
    if (minorMode === true) {
      if (!isMinorSafeModel(model)) {
        let catalog = [];
        try { catalog = await getModelCatalog(); } catch { /* fall through to hardcoded default */ }
        model = catalog.length ? getDefaultMinorModel(catalog) : HARDCODED_MINOR_FALLBACK;
      }
      messages = [MINOR_SYSTEM_PROMPT, ...messages.filter(m => m.role !== 'system')];
    } else {
      // ---- Normal plan-based model gating (non-minor requests only) ----
      if (!isPaidModelAllowed(req.plan.tier, model)) {
        console.log(`[chat] Model ${model} not on plan ${req.plan.tier}, downgrading to free tier model`);
        model = FREE_TIER_MODEL;
      }
    }

    // ---- Privacy routing: "don't train on my inputs" ----
    // Maps to OpenRouter's provider.data_collection field. "deny" tells
    // OpenRouter to only use providers that do not store/train on
    // inputs. See https://openrouter.ai/docs/guides/routing/provider-selection
    // Minor-mode requests always get this protection too, regardless of
    // what the client sends, since it's a strictly-better default for
    // a young person's data.
    let providerPrefs = null;
    if (noTrainOnly === true || minorMode === true) {
      providerPrefs = { data_collection: 'deny' };
    }

    // ---- Forward to OpenRouter ----
    // We don't log req.body.messages content here intentionally.
    console.log(`[chat] Relaying to OpenRouter — model: ${model}, plan: ${req.plan.tier}, noTrainOnly: ${!!providerPrefs}, minorMode: ${!!minorMode}`);

    let openRouterResponse = await callOpenRouter(model, messages, providerPrefs);

    // ---- Fallback: free models on OpenRouter go down/disappear often. ----
    // If the primary model 404s (no endpoint) and a fallback is configured
    // for this plan, retry once with the fallback before giving up.
    if (!openRouterResponse.ok && openRouterResponse.status === 404 && model === FREE_TIER_MODEL) {
      console.warn(`[chat] ${model} returned 404, retrying with fallback ${FALLBACK_FREE_MODEL}`);
      model = FALLBACK_FREE_MODEL;
      openRouterResponse = await callOpenRouter(model, messages, providerPrefs);
    }

    if (!openRouterResponse.ok) {
      const errorText = await openRouterResponse.text();
      console.error(`[chat] OpenRouter error ${openRouterResponse.status}: ${errorText}`);

      // If a strict privacy/minor filter left no eligible provider,
      // give a clearer message than a generic 502.
      if (providerPrefs && openRouterResponse.status === 404) {
        return res.status(502).json({
          error: 'No provider matching your privacy setting is available for this model. Try a different model.',
        });
      }
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    // ---- Stream the response back to the browser ----
    // We pipe OpenRouter's streaming response directly to the client.
    // The content passes through memory briefly but is never written
    // to disk, logged, or stored anywhere.

    // Set headers to tell the browser we're streaming
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');

    // Pipe the response body directly — no buffering, no storing
    const reader = openRouterResponse.body.getReader();
    const decoder = new TextDecoder();

    // Read chunks from OpenRouter and forward immediately to client
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      // Write raw SSE chunks directly to client
      res.write(chunk);
    }

    // Signal to the client that the stream is finished
    res.end();

  } catch (err) {
    console.error('[chat] Error:', err.message);
    // If headers haven't been sent yet, send a JSON error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Relay error. Please try again.' });
    } else {
      // Otherwise close the stream
      res.end();
    }
  }
});

// -------------------------------------------------------
// GET /api/chat/models
// -------------------------------------------------------
// Returns the model picker data for the caller's plan:
//   - flagship: latest OpenAI / Gemini / Claude models, looked up live
//     from OpenRouter (with a `locked` flag if the plan can't use them)
//   - free: every free model currently on OpenRouter, newest first
//     (the frontend shows the first 2 and offers "show more")
//
// minorMode=true (query param) returns only the minor-safe subset.
router.get('/models', requireAuth, async (req, res) => {
  const minorMode = req.query.minorMode === 'true';

  try {
    const catalog  = await getModelCatalog();
    let   flagship = pickFlagshipModels(catalog);
    let   free     = pickFreeModels(catalog);

    if (minorMode) {
      flagship = flagship.filter(m => isMinorSafeModel(m.id)).map(m => ({ ...m, locked: false }));
      free = []; // free/open-weight models excluded from minor mode — see isMinorSafeModel
    } else {
      flagship = flagship.map(m => ({
        ...m,
        locked: !isPaidModelAllowed(req.plan.tier, m.id),
        requiredPlan: classizeRequiredPlan(m.id),
      }));
    }

    res.json({ plan: req.plan.tier, flagship, free, minorMode });
    console.log(`[chat/models] Responded: ${flagship.length} flagship, ${free.length} free, minorMode=${minorMode}`);

  } catch (err) {
    console.error('[chat/models] Falling back to static catalog:', err.message);
    let flagship = STATIC_FALLBACK_FLAGSHIP;
    let free     = STATIC_FALLBACK_FREE;

    if (minorMode) {
      flagship = flagship.filter(m => isMinorSafeModel(m.id)).map(m => ({ ...m, locked: false }));
      free = [];
    } else {
      flagship = flagship.map(m => ({
        ...m,
        locked: !isPaidModelAllowed(req.plan.tier, m.id),
        requiredPlan: classizeRequiredPlan(m.id),
      }));
    }

    res.json({ plan: req.plan.tier, flagship, free, minorMode, fallback: true });
  }
});

// Small helper just for the UI's "upgrade to X" label on locked models.
function classizeRequiredPlan(modelId) {
  const tier = classifyModelTier(modelId);
  if (tier === 'ultra')    return 'pro200';
  if (tier === 'frontier') return 'pro100';
  if (tier === 'cheap')    return 'pro50';
  return 'free';
}

module.exports = router;
