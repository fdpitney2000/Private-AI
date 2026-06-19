-- supabase-setup.sql
-- Run this in your Supabase SQL editor (Dashboard > SQL Editor > New query)
-- This creates the ONE table our app uses — no PII, no chat data.

-- -------------------------------------------------------
-- Subscriptions table
-- Stores only billing entitlements, not user identity.
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id              BIGSERIAL PRIMARY KEY,

  -- The anonymous token we issue to the browser.
  -- This is the only "identity" we have for a user.
  sub_token       TEXT UNIQUE NOT NULL,

  -- Which plan they're on
  plan            TEXT NOT NULL DEFAULT 'free'
                  CHECK (plan IN ('free', 'pro50', 'pro100', 'pro200')),

  -- Stripe subscription ID, used to match webhook events
  stripe_sub_id   TEXT,

  -- SHA-256 hash of the recovery key (NOT the key itself)
  recovery_hash   TEXT,

  -- Daily usage tracking for rate limiting
  requests_today  INTEGER     NOT NULL DEFAULT 0,
  last_reset_date DATE        NOT NULL DEFAULT CURRENT_DATE,

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- NULL = free (no expiry), set for paid subscribers
  expires_at      TIMESTAMPTZ
);

-- Index for fast token lookups (called on every API request)
CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_token
  ON subscriptions(sub_token);

-- Index for webhook lookups by Stripe ID
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id
  ON subscriptions(stripe_sub_id);

-- Index for recovery key lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_recovery_hash
  ON subscriptions(recovery_hash);

-- -------------------------------------------------------
-- RPC function to atomically increment the request counter.
-- This avoids race conditions where two concurrent requests
-- both read "5" and both write "6" instead of "7".
-- -------------------------------------------------------
CREATE OR REPLACE FUNCTION increment_requests(token TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE subscriptions
  SET    requests_today = requests_today + 1
  WHERE  sub_token = token;
END;
$$ LANGUAGE plpgsql;

-- -------------------------------------------------------
-- Row Level Security: DISABLE it for the service role key.
-- Our server uses the service role key, which bypasses RLS anyway.
-- But explicitly disabling it avoids confusing default denials.
-- -------------------------------------------------------
ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- Optional: Insert a test free-tier record to verify setup
-- -------------------------------------------------------
-- INSERT INTO subscriptions (sub_token, plan) VALUES ('test-token-123', 'free');
-- SELECT * FROM subscriptions WHERE sub_token = 'test-token-123';
-- DELETE FROM subscriptions WHERE sub_token = 'test-token-123';
