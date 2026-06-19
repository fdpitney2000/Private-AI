// src/routes/billing.js
// =====================
// Two things live here:
//
// 1. POST /api/billing/checkout  — Creates a Stripe Checkout session
//    so the user can pay. No email required by our app (Stripe
//    asks for payment info only). The session carries a metadata
//    field with the user's anonymous sub_token so we know whose
//    subscription to activate after payment.
//
// 2. POST /webhook/stripe  — Stripe calls this URL after events
//    (payment succeeded, subscription renewed, cancelled, etc.)
//    We verify Stripe's signature to confirm the event is real,
//    then update the Supabase subscription record.
//
// NOTE: The webhook route is mounted at the ROOT level in server.js
// (not under /api/billing) because it needs raw body parsing.
// But the handler is defined here for organisation.

'use strict';

const express = require('express');
const router  = express.Router();
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const {
  createSubscription,
  updateSubscription,
  getSubscriptionByStripeId,
} = require('../services/supabase');

// -------------------------------------------------------
// Plan → Stripe Price ID mapping
// -------------------------------------------------------
const PLAN_PRICES = {
  pro50:  process.env.STRIPE_PRICE_50,
  pro100: process.env.STRIPE_PRICE_100,
  pro200: process.env.STRIPE_PRICE_200,
};

// -------------------------------------------------------
// POST /api/billing/checkout
// -------------------------------------------------------
// The frontend calls this when the user clicks "Upgrade".
// Body: { plan: 'pro50' | 'pro100' | 'pro200', subToken: '...' }
// Returns: { checkoutUrl: 'https://checkout.stripe.com/...' }
//
// subToken is the user's current anonymous subscription token
// (or 'free' if they don't have one yet).
router.post('/checkout', async (req, res) => {
  try {
    const { plan, currentSubToken } = req.body;

    if (!PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan.' });
    }

    // Generate a new anonymous subscription token for this purchase.
    // We store it as Stripe metadata so we can retrieve it in the webhook.
    // This token will be the user's "account key" going forward.
    const newSubToken = uuidv4();

    // Create the Stripe Checkout session
    // Stripe handles all payment info — we never touch card numbers.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',                       // recurring monthly billing
      payment_method_types: ['card'],
      line_items: [{
        price:    PLAN_PRICES[plan],
        quantity: 1,
      }],

      // Where to redirect after success/cancel
      success_url: `${process.env.APP_URL}/?upgraded=true&token={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/?cancelled=true`,

      // Store our anonymous token in Stripe metadata.
      // This is how we link the Stripe payment back to a user
      // without storing any personal information.
      metadata: {
        sub_token:          newSubToken,
        plan:               plan,
        prev_sub_token:     currentSubToken || 'none',
      },

      // We intentionally do NOT pre-fill customer_email.
      // Stripe will ask for it as part of payment processing,
      // but we never see or store it on our side.
      // For true no-email checkout, use Stripe's Payment Links
      // with "Customer email" set to "Don't collect" in the dashboard.
      // That option isn't available via the API yet, so this is a comment
      // to remind you to configure it in the Stripe Dashboard if desired.
    });

    console.log(`[billing] Created checkout session for plan=${plan}`);
    res.json({ checkoutUrl: session.url, pendingToken: newSubToken });

  } catch (err) {
    console.error('[billing/checkout] Error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// -------------------------------------------------------
// GET /api/billing/portal
// -------------------------------------------------------
// Redirects the user to Stripe's Customer Portal where they
// can manage/cancel their subscription without involving us.
// Body: { subToken: '...' }
router.post('/portal', async (req, res) => {
  try {
    const { subToken } = req.body;
    // TODO: look up the Stripe customer ID from Supabase using subToken,
    // then create a billing portal session. Omitted for brevity but
    // the pattern is identical to the checkout session above.
    res.json({ message: 'Portal not yet implemented.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------
// POST /webhook/stripe
// -------------------------------------------------------
// Stripe sends signed POST requests here for billing events.
// This route is mounted at the root level (see server.js) so
// that it receives the raw body before express.json() parses it.
//
// CRITICAL: Always verify the Stripe signature before doing anything.
// Without this check, anyone could send fake "payment succeeded" events.
router.post('/', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const payload = req.body; // raw Buffer, NOT parsed JSON

  let event;
  try {
    // stripe.webhooks.constructEvent throws if the signature is invalid
    event = stripe.webhooks.constructEvent(
      payload,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    // Return 400 to tell Stripe the event was rejected
    return res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
  }

  console.log(`[webhook] Received event: ${event.type}`);

  // Handle events we care about
  try {
    switch (event.type) {

      // ---- Payment succeeded (first payment) ----
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Only handle subscription checkouts (not one-time payments)
        if (session.mode !== 'subscription') break;

        const { sub_token, plan } = session.metadata;
        const stripeSubId = session.subscription;

        // Calculate when the subscription expires
        // Stripe will send renewal events to extend this automatically
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 1);

        // Generate a recovery key for paid users
        // This is shown once to the user after upgrade
        const recoveryKey  = generateRecoveryKey();
        const recoveryHash = hashRecoveryKey(recoveryKey);

        // Store the entitlement (NOT the user's email or payment info)
        await createSubscription({
          subToken:     sub_token,
          plan:         plan,
          stripeSubId:  stripeSubId,
          expiresAt:    expiresAt.toISOString(),
          recoveryHash: recoveryHash,
        });

        // The recovery key is stored only in Supabase as a HASH.
        // We can't show it to the user from the webhook (async).
        // Instead, the frontend retrieves it during the success redirect
        // via a separate /api/account/recovery-key endpoint that
        // returns it ONCE and then marks it as shown.
        // (See account.js for that endpoint.)

        console.log(`[webhook] Subscription activated: plan=${plan}`);
        break;
      }

      // ---- Subscription renewed ----
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason !== 'subscription_cycle') break;

        const stripeSubId = invoice.subscription;
        const sub = await getSubscriptionByStripeId(stripeSubId);
        if (!sub) break;

        // Extend the expiry by one month
        const newExpiry = new Date();
        newExpiry.setMonth(newExpiry.getMonth() + 1);

        await updateSubscription(sub.sub_token, {
          expires_at: newExpiry.toISOString(),
        });

        console.log(`[webhook] Subscription renewed for sub_token=${sub.sub_token}`);
        break;
      }

      // ---- Subscription cancelled ----
      case 'customer.subscription.deleted': {
        const stripeSub = event.data.object;
        const sub = await getSubscriptionByStripeId(stripeSub.id);
        if (!sub) break;

        // Downgrade to free at end of period
        await updateSubscription(sub.sub_token, {
          plan:       'free',
          expires_at: null,
        });

        console.log(`[webhook] Subscription cancelled: ${stripeSub.id}`);
        break;
      }

      // ---- Ignore all other events ----
      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }

    // Always return 200 to acknowledge receipt.
    // Stripe will retry on non-200 responses.
    res.json({ received: true });

  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
    // Return 500 so Stripe knows to retry this event later
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

// -------------------------------------------------------
// Helper: Generate a random recovery key
// -------------------------------------------------------
// Format: XXXX-XXXX-XXXX-XXXX (easy to write down)
function generateRecoveryKey() {
  const bytes = crypto.randomBytes(8);
  const hex   = bytes.toString('hex').toUpperCase();
  // Split into 4 groups of 4 characters
  return `${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`;
}

// -------------------------------------------------------
// Helper: Hash a recovery key for storage
// -------------------------------------------------------
// We store the hash, not the key itself. This way even if
// the database is compromised, the raw keys aren't exposed.
// We use SHA-256 here for simplicity; use bcrypt in production
// for stronger protection.
function hashRecoveryKey(key) {
  return crypto.createHash('sha256').update(key + process.env.APP_SECRET).digest('hex');
}

module.exports = router;
// Also export the helpers so account.js can use them
module.exports.generateRecoveryKey = generateRecoveryKey;
module.exports.hashRecoveryKey     = hashRecoveryKey;
