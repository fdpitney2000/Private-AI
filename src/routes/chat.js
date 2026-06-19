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

'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth, isModelAllowed } = require('../middleware/auth');

// Default model for free tier users
const FREE_TIER_MODEL = 'mistralai/mistral-7b-instruct';

// -------------------------------------------------------
// POST /api/chat
// -------------------------------------------------------
// Body: { messages: [...], model: "model-id" }
// messages follows the OpenAI format:
//   [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi!" }, ...]
//
// The browser is responsible for maintaining conversation history
// in localStorage. The server sees all messages each time but
// logs none of them.
router.post('/', requireAuth, async (req, res) => {
  try {
    const { messages, model: requestedModel } = req.body;

    // ---- Validate inputs ----
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }

    // Enforce message count limit to prevent abuse
    if (messages.length > 100) {
      return res.status(400).json({ error: 'Too many messages in context (max 100).' });
    }

    // ---- Model selection ----
    // If the user requests a model not on their plan, fall back gracefully
    let model = requestedModel || FREE_TIER_MODEL;
    if (!isModelAllowed(req.plan, model)) {
      // Don't error — just silently downgrade to the best model they can use.
      // You could instead return a 403 if you prefer to show an upgrade prompt.
      const allowed = req.plan.limits.allowedModels;
      model = allowed[allowed.length - 1]; // pick the "best" allowed model
      console.log(`[chat] Model ${requestedModel} not on plan ${req.plan.tier}, using ${model}`);
    }

    // ---- Forward to OpenRouter ----
    // We don't log req.body.messages content here intentionally.
    console.log(`[chat] Relaying to OpenRouter — model: ${model}, plan: ${req.plan.tier}`);

    const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization':    `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type':     'application/json',
        // OpenRouter optionally uses HTTP-Referer for analytics.
        // Using a generic label keeps users anonymous there too.
        'HTTP-Referer':     process.env.APP_URL || 'http://localhost:3000',
        'X-Title':          'Privacy Chat App',
      },
      body: JSON.stringify({
        model:    model,
        messages: messages,
        stream:   true,   // Stream tokens as they're generated
        max_tokens: 2048,
      }),
    });

    if (!openRouterResponse.ok) {
      const errorText = await openRouterResponse.text();
      console.error(`[chat] OpenRouter error ${openRouterResponse.status}: ${errorText}`);
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
// Returns the list of models available on the caller's plan.
// The frontend uses this to populate the model selector.
router.get('/models', requireAuth, (req, res) => {
  const allowed = req.plan.limits.allowedModels;

  // The model catalogue — display names for the frontend
  const allModels = [
    { id: 'mistralai/mistral-7b-instruct', name: 'Mistral 7B (Free)',      minPlan: 'free'   },
    { id: 'google/gemma-7b-it',            name: 'Gemma 7B (Free)',        minPlan: 'free'   },
    { id: 'openai/gpt-4o-mini',            name: 'GPT-4o Mini',            minPlan: 'pro50'  },
    { id: 'anthropic/claude-3-haiku',      name: 'Claude 3 Haiku',         minPlan: 'pro50'  },
    { id: 'openai/gpt-4o',                name: 'GPT-4o',                 minPlan: 'pro100' },
    { id: 'anthropic/claude-3-5-sonnet',   name: 'Claude 3.5 Sonnet',      minPlan: 'pro100' },
    { id: 'anthropic/claude-opus-4',       name: 'Claude Opus 4',          minPlan: 'pro200' },
    { id: 'openai/o1',                     name: 'OpenAI o1',              minPlan: 'pro200' },
  ];

  const available = allowed.includes('*')
    ? allModels
    : allModels.filter(m => allowed.includes(m.id));

  res.json({ models: available, plan: req.plan.tier });
});

module.exports = router;
