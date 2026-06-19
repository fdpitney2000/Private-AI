// server.js — Main entry point for the privacy-first chat app
// ============================================================
// This file boots Express, registers middleware, mounts routes,
// and starts listening. Keep it thin — logic lives in /src.

'use strict';

// Load environment variables from .env into process.env
// This must happen before anything else reads process.env
require('dotenv').config();

const express = require('express');
const path    = require('path');

// --- Import our route modules ---
const chatRoutes    = require('./src/routes/chat');
const billingRoutes = require('./src/routes/billing');
const accountRoutes = require('./src/routes/account');

const app  = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------
// STRIPE WEBHOOK — must come BEFORE express.json()
// -------------------------------------------------------
// Stripe sends a raw Buffer body and signs it with your
// webhook secret. express.json() would parse it into JSON
// and destroy the raw bytes Stripe needs to verify the
// signature. So we register the raw-body route first.
app.use(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  billingRoutes
);

// -------------------------------------------------------
// Global middleware
// -------------------------------------------------------

// Parse JSON bodies for all other routes
app.use(express.json());

// Serve static files (HTML, CSS, JS) from the /public folder
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------
// Security headers
// -------------------------------------------------------
// These headers harden the app against common web attacks.
// On Hostinger, Nginx may add some of these too — that's fine,
// duplicates are harmless.
app.use((req, res, next) => {
  // Prevent browsers from sniffing content types
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Don't embed this app in iframes (clickjacking protection)
  res.setHeader('X-Frame-Options', 'DENY');
  // Basic XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Only allow HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// -------------------------------------------------------
// API Routes
// -------------------------------------------------------
app.use('/api/chat',    chatRoutes);    // OpenRouter relay
app.use('/api/billing', billingRoutes); // Stripe Checkout creation
app.use('/api/account', accountRoutes); // UID/recovery

// -------------------------------------------------------
// SPA fallback — send index.html for unknown GET routes
// -------------------------------------------------------
// This lets the frontend handle routing without 404s.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------------------------------------------
// Global error handler
// -------------------------------------------------------
// Any route that calls next(err) lands here.
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  // Never expose internal error details to the client in production
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message
  });
});

// -------------------------------------------------------
// Start the server
// -------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
});
