// src/routes/account.js
// ======================
// Handles the anonymous identity layer of the app.
//
// The server does NOT generate UIDs — the browser does that.
// This file handles the server-side pieces:
//   - POST /api/account/recover  — Recover a lost sub_token via recovery key
//   - GET  /api/account/recovery-key  — Show recovery key ONCE after upgrade
//   - GET  /api/account/status  — Check current plan/limits for a sub_token

'use strict';

const express = require('express');
const router  = express.Router();

const {
  getSubscription,
  getSubscriptionByRecoveryHash,
  updateSubscription,
} = require('../services/supabase');

const { PLAN_LIMITS } = require('../middleware/auth');
const { hashRecoveryKey } = require('./billing');

// -------------------------------------------------------
// GET /api/account/status
// -------------------------------------------------------
// The browser sends its sub_token (or 'free') and gets back
// its current plan details. Used on page load to show the
// correct UI state.
router.get('/status', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    const subToken   = authHeader.replace('Bearer ', '').trim();

    // Free tier — no token
    if (!subToken || subToken === 'free') {
      return res.json({
        plan:   'free',
        limits: PLAN_LIMITS.free,
        active: true,
      });
    }

    const sub = await getSubscription(subToken);

    if (!sub) {
      // Token doesn't exist — treat as free but flag it
      return res.json({ plan: 'free', limits: PLAN_LIMITS.free, active: false, tokenUnknown: true });
    }

    const expired = sub.expires_at && new Date(sub.expires_at) < new Date();
    const plan    = expired ? 'free' : sub.plan;

    res.json({
      plan:          plan,
      limits:        PLAN_LIMITS[plan] || PLAN_LIMITS.free,
      active:        !expired,
      requestsToday: sub.requests_today || 0,
      expiresAt:     sub.expires_at,
    });

  } catch (err) {
    console.error('[account/status] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch account status.' });
  }
});

// -------------------------------------------------------
// GET /api/account/recovery-key
// -------------------------------------------------------
// Called once after a successful upgrade (from the success
// redirect URL). Returns the plaintext recovery key so the
// user can write it down. After this, we mark recovery_key_shown
// in Supabase so it can never be returned again.
//
// NOTE: The actual recovery key cannot be re-derived from the hash.
// If the user loses it, there's no recovery — that's intentional
// and consistent with the app's privacy model.
//
// For this to work, the plaintext key needs to be stored TEMPORARILY
// somewhere the server can read it. Options:
//   a) Store it encrypted in Supabase for 24h, then delete it
//   b) Include it in the Stripe success URL (simplest, some risk)
//   c) Return it in the checkout response and have the frontend
//      show it immediately (cleanest for privacy)
//
// We use option (c) here: the frontend gets the key from the
// checkout initiation response and is responsible for showing it.
// The server only stores the hash. See the frontend app.js for
// how this is displayed to the user.
router.get('/recovery-key', async (req, res) => {
  // This endpoint is intentionally left as a placeholder.
  // See the comment above — we use approach (c): the plaintext key
  // is never stored on the server, only the hash is.
  // The frontend receives and displays the key at checkout time.
  res.json({ message: 'Recovery key is shown once at upgrade time and never stored in plaintext.' });
});

// -------------------------------------------------------
// POST /api/account/recover
// -------------------------------------------------------
// Lets a user recover access to their paid subscription
// by entering their recovery key.
//
// Body: { recoveryKey: 'XXXX-XXXX-XXXX-XXXX' }
// Returns: { subToken: '...' }  — a new token the browser stores
//
// No email required. No identity verification. Just the key.
router.post('/recover', async (req, res) => {
  try {
    const { recoveryKey } = req.body;

    if (!recoveryKey || typeof recoveryKey !== 'string') {
      return res.status(400).json({ error: 'Recovery key is required.' });
    }

    // Normalise the key (remove spaces, uppercase)
    const normalised = recoveryKey.trim().toUpperCase().replace(/\s+/g, '');

    // Hash it and look it up in Supabase
    const hash = hashRecoveryKey(normalised);
    const sub  = await getSubscriptionByRecoveryHash(hash);

    if (!sub) {
      // Don't reveal whether the key exists or not — generic error
      return res.status(404).json({ error: 'Recovery key not found or already used.' });
    }

    // Check the subscription is still valid
    const expired = sub.expires_at && new Date(sub.expires_at) < new Date();
    if (expired) {
      return res.status(402).json({ error: 'This subscription has expired.' });
    }

    // Issue a brand-new sub_token (the old one may be compromised)
    const { v4: uuidv4 } = require('uuid');
    const newSubToken = uuidv4();

    // Rotate the token in Supabase
    await updateSubscription(sub.sub_token, {
      sub_token: newSubToken,
      // Optionally invalidate the recovery key after use:
      // recovery_hash: null,
    });

    // Return the new token to the browser
    // The browser will store this in localStorage
    res.json({
      subToken: newSubToken,
      plan:     sub.plan,
      message:  'Account recovered. Store your new token safely.',
    });

    console.log(`[account/recover] Issued new sub_token for recovered account, plan=${sub.plan}`);

  } catch (err) {
    console.error('[account/recover] Error:', err.message);
    res.status(500).json({ error: 'Recovery failed. Please try again.' });
  }
});

module.exports = router;
