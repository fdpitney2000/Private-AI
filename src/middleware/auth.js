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
    // Models allowed on the free tier (low-cost OpenRouter models)
    allowedModels: [
      'cohere/north-mini-code:free',
      'nex-agi/nex-n2-pro:free',
    ],
  },
  pro50: {
    requestsPerDay: 200,
    allowedModels: [
      'mistralai/mistral-7b-instruct',
      'google/gemma-7b-it',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-haiku',
    ],
  },
  pro100: {
    requestsPerDay: 500,
    allowedModels: [
      'mistralai/mistral-7b-instruct',
      'google/gemma-7b-it',
      'openai/gpt-4o-mini',
      'anthropic/claude-3-haiku',
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
// Model access check helper
// -------------------------------------------------------
// Call this in the chat route to verify the requested model
// is allowed on the user's plan.
function isModelAllowed(plan, requestedModel) {
  const allowed = plan.limits.allowedModels;
  if (allowed.includes('*')) return true;            // pro200: all models
  return allowed.includes(requestedModel);
}

module.exports = { requireAuth, isModelAllowed, PLAN_LIMITS };
