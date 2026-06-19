// src/services/supabase.js
// ========================
// A thin wrapper around the Supabase client.
// IMPORTANT: This file only stores BILLING ENTITLEMENTS.
// No chat data, no prompts, no responses, no real user identity.
//
// The Supabase table we use looks like this (run this SQL in your
// Supabase SQL editor to create it):
//
//   CREATE TABLE subscriptions (
//     id              SERIAL PRIMARY KEY,
//     sub_token       TEXT UNIQUE NOT NULL,  -- anonymous token we give user
//     plan            TEXT NOT NULL,         -- 'free' | 'pro50' | 'pro100' | 'pro200'
//     stripe_sub_id   TEXT,                  -- Stripe subscription ID (for cancellations)
//     recovery_hash   TEXT,                  -- bcrypt hash of recovery key (paid only)
//     requests_today  INTEGER DEFAULT 0,     -- for rate limiting
//     last_reset_date DATE DEFAULT NOW(),    -- reset requests_today daily
//     created_at      TIMESTAMPTZ DEFAULT NOW(),
//     expires_at      TIMESTAMPTZ            -- NULL = free, set for paid
//   );
//
//   -- Index for fast token lookups on every request
//   CREATE INDEX idx_sub_token ON subscriptions(sub_token);

'use strict';

const { createClient } = require('@supabase/supabase-js');

// Use the SERVICE ROLE key (not the anon key) because this runs
// server-side and needs to bypass Row Level Security.
// Never expose the service key to the frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// -------------------------------------------------------
// Look up a subscription record by anonymous token.
// Returns the row or null if not found.
// -------------------------------------------------------
async function getSubscription(subToken) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('sub_token', subToken)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = "no rows returned", which is fine (user not found)
    throw new Error(`Supabase lookup failed: ${error.message}`);
  }
  return data || null;
}

// -------------------------------------------------------
// Create a new subscription record (called after Stripe
// webhook confirms payment).
// -------------------------------------------------------
async function createSubscription({ subToken, plan, stripeSubId, expiresAt, recoveryHash }) {
  const { data, error } = await supabase
    .from('subscriptions')
    .insert([{
      sub_token:      subToken,
      plan:           plan,
      stripe_sub_id:  stripeSubId,
      recovery_hash:  recoveryHash || null,
      expires_at:     expiresAt    || null,
    }])
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return data;
}

// -------------------------------------------------------
// Update an existing subscription (e.g. after renewal).
// -------------------------------------------------------
async function updateSubscription(subToken, updates) {
  const { data, error } = await supabase
    .from('subscriptions')
    .update(updates)
    .eq('sub_token', subToken)
    .select()
    .single();

  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return data;
}

// -------------------------------------------------------
// Increment the daily request counter for rate limiting.
// Resets the counter if last_reset_date was before today.
// -------------------------------------------------------
async function incrementRequestCount(subToken) {
  const today = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'

  // First, reset the counter if it's a new day
  await supabase
    .from('subscriptions')
    .update({ requests_today: 0, last_reset_date: today })
    .eq('sub_token', subToken)
    .lt('last_reset_date', today); // only update if last reset was before today

  // Now increment
  const { error } = await supabase.rpc('increment_requests', { token: subToken });
  if (error) {
    // Fall back to a manual update if the RPC doesn't exist
    await supabase
      .from('subscriptions')
      .update({ requests_today: supabase.rpc('requests_today + 1') })
      .eq('sub_token', subToken);
  }
}

// -------------------------------------------------------
// Look up a subscription by its Stripe subscription ID.
// Used in webhook handlers to find which record to update.
// -------------------------------------------------------
async function getSubscriptionByStripeId(stripeSubId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('stripe_sub_id', stripeSubId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Supabase lookup failed: ${error.message}`);
  }
  return data || null;
}

// -------------------------------------------------------
// Look up a subscription by recovery key hash.
// -------------------------------------------------------
async function getSubscriptionByRecoveryHash(hash) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('recovery_hash', hash)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Supabase lookup failed: ${error.message}`);
  }
  return data || null;
}

module.exports = {
  getSubscription,
  createSubscription,
  updateSubscription,
  incrementRequestCount,
  getSubscriptionByStripeId,
  getSubscriptionByRecoveryHash,
};
