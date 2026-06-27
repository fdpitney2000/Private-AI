// src/middleware/auth.js
// ======================
// This middleware runs on every /api/chat request.
// It validates the subscription token the browser sends,
// looks up the user's plan, checks rate limits, and
// attaches plan info to req.plan for the route to use.
//
// The browser sends: Authorization: Bearer <subToken>
// subToken is an anonymous random string — not a JWT,
// not tied to any real identity.

'use strict';

const { getSubscription, incrementRequestCount } = require('../services/supabase');

// -------------------------------------------------------
// Plan configuration
// -------------------------------------------------------
// Define what each plan can do. Add or change tiers here.
const PLAN_LIMITS = {
  free: {
    requestsPerDay: 10,
    // Models allowed on the free tier — OpenRouter's free-tier models
    // require the ":free" suffix, or OpenRouter routes to the paid
    // endpoint (which may 404 if you have no credit / no active route).
    // NOTE: OpenRouter's free model catalog changes often. If one of
    // these starts 404ing, check https://openrouter.ai/models?max_price=0
    // for current free model IDs and update this list.
    allowedModels: [
      'mistralai/mistral-7b-instruct:free',
      'meta-llama/llama-4-scout:free',
    ],
  },
  pro50: {
    requestsPerDay: 200,
    allowedModels: [
      'mistralai/mistral-7b-instruct:free',
      'meta-llama/llama-4-scout:free',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-5-haiku',
    ],
  },
  pro100: {
    requestsPerDay: 500,
    allowedModels: [
      'mistralai/mistral-7b-instruct:free',
      'meta-llama/llama-4-scout:free',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-5-haiku',
      'openai/gpt-4o',
      'anthropic/claude-3-5-sonnet',
    ],
  },
  pro200: {
    requestsPerDay: 2000,
    allowedModels: [
      // All models — unrestricted
      '*'
    ],
  },
};

// -------------------------------------------------------
// Main middleware function
// -------------------------------------------------------
async function requireAuth(req, res, next) {
  try {
    // Extract the token from the Authorization header
    const authHeader = req.headers['authorization'] || '';
    const subToken   = authHeader.replace('Bearer ', '').trim();

    // ---- Free tier: no token ----
    // If no token is provided, treat as free tier but require
    // the request to include a stable browser fingerprint (UID)
    // so we can rate-limit per-browser even without an account.
    if (!subToken || subToken === 'free') {
      const uid = req.headers['x-anonymous-uid'] || 'unknown';

      // For simplicity, free tier just checks a basic rate limit.
      // In production you'd store this in Redis or Supabase too.
      // Here we attach plan info and let the route handle it.
      req.plan = {
        tier: 'free',
        uid:  uid,
        limits: PLAN_LIMITS.free,
      };
      return next();
    }

    // ---- Paid tier: validate token ----
    const subscription = await getSubscription(subToken);

    if (!subscription) {
      return res.status(401).json({ error: 'Invalid subscription token.' });
    }

    // Check if subscription has expired
    if (subscription.expires_at && new Date(subscription.expires_at) < new Date()) {
      return res.status(402).json({
        error: 'Subscription expired. Please renew.',
        expired: true,
      });
    }

    const planLimits = PLAN_LIMITS[subscription.plan] || PLAN_LIMITS.free;

    // Check daily rate limit
    if (subscription.requests_today >= planLimits.requestsPerDay) {
      return res.status(429).json({
        error: `Daily limit of ${planLimits.requestsPerDay} requests reached. Resets at midnight.`,
        rateLimited: true,
      });
    }

    // Attach plan info to the request for the route to use
    req.plan       = { tier: subscription.plan, limits: planLimits };
    req.subToken   = subToken;
    req.subRecord  = subscription;

    // Increment usage counter (fire and forget — don't block the response)
    incrementRequestCount(subToken).catch(err =>
      console.error('[auth] Failed to increment request count:', err.message)
    );

    next();

  } catch (err) {
    console.error('[auth] Middleware error:', err.message);
    next(err); // Passes to the global error handler in server.js
  }
}

// -------------------------------------------------------
// Model access check helper (legacy — static list)
// -------------------------------------------------------
// Kept for backward compatibility / reference. The chat route now uses
// classifyModelTier()/isPaidModelAllowed() below instead, since the
// model picker is populated dynamically from OpenRouter's live catalog
// (see CONTEXT.md — hardcoded model IDs go stale and 404).
function isModelAllowed(plan, requestedModel) {
  const allowed = plan.limits.allowedModels;
  if (allowed.includes('*')) return true;            // pro200: all models
  return allowed.includes(requestedModel);
}

// -------------------------------------------------------
// Dynamic model tier classification
// -------------------------------------------------------
// Rather than maintaining a hardcoded list of exact model IDs per plan
// (which breaks every time a provider ships a new version), we classify
// any model ID into a cost tier by pattern-matching its slug, and gate
// plans against the tier rather than the exact ID. This keeps working
// automatically as OpenRouter's catalog changes.
//
//   free     -> ":free" suffix models, available to everyone
//   cheap    -> "mini"/"haiku"/"flash-lite" variants, requires pro50+
//   frontier -> mainline flagship models (gpt-5.x, gemini-3-pro, claude
//               sonnet), requires pro100+
//   ultra    -> top-of-line "opus"-class models, requires pro200
function classifyModelTier(modelId) {
  if (!modelId) return 'frontier';
  if (modelId.endsWith(':free')) return 'free';
  if (/opus/i.test(modelId)) return 'ultra';
  if (/mini|haiku|flash-lite/i.test(modelId)) return 'cheap';
  return 'frontier';
}

const TIER_ORDER = ['cheap', 'frontier', 'ultra'];
const PLAN_MAX_TIER_INDEX = { free: -1, pro50: 0, pro100: 1, pro200: 2 };

function isPaidModelAllowed(planTier, modelId) {
  const tier = classifyModelTier(modelId);
  if (tier === 'free') return true;
  const maxIndex = PLAN_MAX_TIER_INDEX[planTier] ?? -1;
  return TIER_ORDER.indexOf(tier) <= maxIndex;
}

module.exports = {
  requireAuth,
  isModelAllowed,
  classifyModelTier,
  isPaidModelAllowed,
  PLAN_LIMITS,
};
