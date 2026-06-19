// public/js/app.js
// =================
// All client-side logic for the privacy-first chat app.
//
// KEY PRIVACY PRINCIPLES IN THIS FILE:
// - All user identity lives in localStorage, never sent to server except as opaque token
// - Chat history lives in localStorage only
// - Conversation is NEVER sent to our server except to relay to OpenRouter (no logging)
// - UID is generated client-side using crypto.randomUUID()

'use strict';

// ============================================================
// 1. IDENTITY MANAGEMENT
//    Generate and persist anonymous UID + password in localStorage
// ============================================================

const STORAGE_KEYS = {
  uid:         'pc_uid',         // anonymous user ID (display only)
  password:    'pc_password',    // password (stored locally, not sent anywhere currently)
  subToken:    'pc_sub_token',   // subscription token (sent to server for billing checks)
  chatHistory: 'pc_chat_history',// array of messages
  plan:        'pc_plan',        // cached plan name
};

/**
 * Generate a random 6-character alphanumeric string for the UID.
 * This is for display/logging purposes only — it never leaves the browser
 * except as part of the opaque subToken for billing.
 */
function generateUID() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars like 0,O,I,1
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => chars[b % chars.length])
    .join('');
}

/**
 * Generate a random password (stored locally only — not transmitted).
 * Useful for Stage 2 local encryption of chat history.
 */
function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}

/**
 * Load existing identity from localStorage, or create new one on first visit.
 */
function initIdentity() {
  let uid      = localStorage.getItem(STORAGE_KEYS.uid);
  let password = localStorage.getItem(STORAGE_KEYS.password);

  if (!uid) {
    uid      = generateUID();
    password = generatePassword();
    localStorage.setItem(STORAGE_KEYS.uid,      uid);
    localStorage.setItem(STORAGE_KEYS.password, password);
    console.log('[identity] Created new anonymous identity:', uid);
  }

  // Display the UID to the user
  const displayEl = document.getElementById('display-uid');
  if (displayEl) displayEl.textContent = uid;

  return { uid, password };
}

// ============================================================
// 2. CHAT HISTORY (localStorage)
// ============================================================

/** Load chat history from localStorage. Returns array of {role, content} objects. */
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.chatHistory);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Save chat history to localStorage. */
function saveHistory(messages) {
  try {
    // Keep only the last 100 messages to avoid filling localStorage
    const trimmed = messages.slice(-100);
    localStorage.setItem(STORAGE_KEYS.chatHistory, JSON.stringify(trimmed));
  } catch (e) {
    console.error('[history] Could not save:', e.message);
  }
}

/** Render all messages from history into the chat window. */
function renderHistory(messages) {
  const container = document.getElementById('chat-messages');
  // Clear existing messages (except the welcome system message)
  const systemMsg = container.querySelector('.system-message');
  container.innerHTML = '';
  if (systemMsg) container.appendChild(systemMsg);

  messages.forEach(msg => appendMessage(msg.role, msg.content));
}

// ============================================================
// 3. CHAT UI
// ============================================================

/**
 * Append a message bubble to the chat window.
 * @param {string} role    - 'user' | 'assistant'
 * @param {string} content - The message text (may be markdown-ish)
 * @returns {HTMLElement}  - The bubble element (for streaming updates)
 */
function appendMessage(role, content) {
  const container = document.getElementById('chat-messages');

  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = renderContent(content); // basic markdown rendering

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'user' ? 'You' : 'AI';

  wrapper.appendChild(meta);
  wrapper.appendChild(bubble);
  container.appendChild(wrapper);

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;

  return bubble; // return so streaming can update it
}

/**
 * Very basic content rendering — escapes HTML then formats code blocks.
 * For production, use a proper Markdown parser like marked.js.
 */
function renderContent(text) {
  // Escape HTML to prevent XSS
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Format ```code blocks```
  return escaped
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

// ============================================================
// 4. SEND A MESSAGE
// ============================================================

let isStreaming = false; // prevent double-sends

async function sendMessage(userText) {
  if (!userText.trim() || isStreaming) return;
  isStreaming = true;

  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled  = true;
  sendBtn.textContent = 'Sending…';

  // Add user message to history and UI
  const history = loadHistory();
  history.push({ role: 'user', content: userText });
  saveHistory(history);
  appendMessage('user', userText);

  // Create a placeholder for the AI response (will be filled by streaming)
  const assistantBubble = appendMessage('assistant', '…');
  assistantBubble.closest('.message').classList.add('streaming');

  let fullResponse = '';

  try {
    const subToken    = localStorage.getItem(STORAGE_KEYS.subToken) || 'free';
    const uid         = localStorage.getItem(STORAGE_KEYS.uid);
    const selectedModel = document.getElementById('model-select').value;

    // POST to our relay server — NOT to OpenRouter directly.
    // The server holds the OpenRouter API key securely.
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'Authorization':    `Bearer ${subToken}`,
        'X-Anonymous-UID':  uid || 'unknown', // for free-tier rate limiting
      },
      body: JSON.stringify({
        messages: history,          // full conversation context
        model:    selectedModel,
      }),
    });

    // Handle errors before streaming
    if (!response.ok) {
      const err = await response.json();

      if (response.status === 402) {
        // Subscription expired
        showError(assistantBubble, 'Your subscription has expired. Please renew.');
        showUpgradeModal();
        return;
      }
      if (response.status === 429) {
        showError(assistantBubble, err.error || 'Rate limit reached. Try again tomorrow.');
        return;
      }

      showError(assistantBubble, err.error || 'Something went wrong.');
      return;
    }

    // ---- Stream the response ----
    // The server sends Server-Sent Events (SSE) in OpenAI format:
    // "data: { choices: [{ delta: { content: '...' } }] }"
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      // Each chunk may contain multiple "data: ..." lines
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.replace('data: ', '').trim();
        if (dataStr === '[DONE]') break;

        try {
          const parsed = JSON.parse(dataStr);
          const delta  = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullResponse += delta;
            // Update the bubble in real-time
            assistantBubble.innerHTML = renderContent(fullResponse);
            // Scroll to bottom as content arrives
            document.getElementById('chat-messages').scrollTop =
              document.getElementById('chat-messages').scrollHeight;
          }
        } catch {
          // Ignore malformed chunks
        }
      }
    }

    // ---- Save completed response to history ----
    history.push({ role: 'assistant', content: fullResponse });
    saveHistory(history);

  } catch (err) {
    console.error('[chat] Error:', err);
    showError(assistantBubble, 'Network error. Please check your connection.');
  } finally {
    // Clean up streaming state
    assistantBubble.closest('.message')?.classList.remove('streaming');
    isStreaming       = false;
    sendBtn.disabled  = false;
    sendBtn.textContent = 'Send';

    // Refresh usage info
    loadAccountStatus();
  }
}

function showError(bubble, message) {
  bubble.innerHTML = `<span style="color:var(--danger)">${message}</span>`;
  bubble.closest('.message')?.classList.remove('streaming');
  isStreaming = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('send-btn').textContent = 'Send';
}

// ============================================================
// 5. ACCOUNT STATUS
// ============================================================

async function loadAccountStatus() {
  try {
    const subToken = localStorage.getItem(STORAGE_KEYS.subToken) || 'free';

    const response = await fetch('/api/account/status', {
      headers: { 'Authorization': `Bearer ${subToken}` }
    });

    if (!response.ok) return;

    const data = await response.json();

    // Update plan badge
    const badge = document.getElementById('plan-badge');
    const planNames = { free: 'Free', pro50: 'Pro 50', pro100: 'Pro 100', pro200: 'Pro 200' };
    badge.textContent = planNames[data.plan] || data.plan;
    badge.className   = `plan-badge plan-${data.plan}`;

    // Update usage info
    const usageEl = document.getElementById('usage-info');
    if (data.requestsToday !== undefined) {
      const limit = data.limits?.requestsPerDay;
      usageEl.textContent = `${data.requestsToday} / ${limit} requests today`;
    }

    // Cache plan locally
    localStorage.setItem(STORAGE_KEYS.plan, data.plan);

    // Show/hide upgrade button
    document.getElementById('upgrade-btn').hidden = data.plan === 'pro200';

  } catch (err) {
    console.error('[status] Could not load account status:', err.message);
  }
}

// ============================================================
// 6. MODEL LIST
// ============================================================

async function loadModels() {
  try {
    const subToken = localStorage.getItem(STORAGE_KEYS.subToken) || 'free';
    const response = await fetch('/api/chat/models', {
      headers: { 'Authorization': `Bearer ${subToken}` }
    });

    if (!response.ok) return;

    const { models } = await response.json();
    const select = document.getElementById('model-select');
    select.innerHTML = models
      .map(m => `<option value="${m.id}">${m.name}</option>`)
      .join('');

  } catch (err) {
    console.error('[models] Could not load models:', err.message);
  }
}

// ============================================================
// 7. BILLING — STRIPE CHECKOUT
// ============================================================

async function startCheckout(plan) {
  try {
    const currentSubToken = localStorage.getItem(STORAGE_KEYS.subToken) || 'free';

    const response = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, currentSubToken }),
    });

    const data = await response.json();

    if (!response.ok) {
      alert('Could not start checkout: ' + (data.error || 'Unknown error'));
      return;
    }

    // Store the pending token — after payment, we'll activate it
    // The recovery key will be generated server-side and associated with this token
    localStorage.setItem('pc_pending_token',        data.pendingToken);
    localStorage.setItem('pc_pending_recovery_key', data.recoveryKey || '');

    // Redirect to Stripe Checkout
    window.location.href = data.checkoutUrl;

  } catch (err) {
    console.error('[checkout] Error:', err);
    alert('Checkout failed. Please try again.');
  }
}

/**
 * Handle the redirect back from Stripe Checkout.
 * The URL will contain ?upgraded=true if payment succeeded.
 */
function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('upgraded') === 'true') {
    // Activate the pending token
    const pendingToken   = localStorage.getItem('pc_pending_token');
    const pendingRecKey  = localStorage.getItem('pc_pending_recovery_key');

    if (pendingToken) {
      localStorage.setItem(STORAGE_KEYS.subToken, pendingToken);
      localStorage.removeItem('pc_pending_token');

      // Show recovery key modal if we have one
      if (pendingRecKey) {
        document.getElementById('recovery-key-display').textContent = pendingRecKey;
        showModal('recovery-modal');
        localStorage.removeItem('pc_pending_recovery_key');
      }

      // Reload status and models
      loadAccountStatus();
      loadModels();
    }

    // Clean the URL
    window.history.replaceState({}, '', '/');
  }

  if (params.get('cancelled') === 'true') {
    window.history.replaceState({}, '', '/');
    // Could show a "checkout cancelled" message here
  }
}

// ============================================================
// 8. ACCOUNT RECOVERY
// ============================================================

async function recoverAccount() {
  const input = document.getElementById('recovery-key-input');
  const errorEl = document.getElementById('recover-error');
  const key   = input.value.trim();

  errorEl.hidden = true;

  if (!key) {
    errorEl.textContent = 'Please enter your recovery key.';
    errorEl.hidden = false;
    return;
  }

  try {
    const response = await fetch('/api/account/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recoveryKey: key }),
    });

    const data = await response.json();

    if (!response.ok) {
      errorEl.textContent = data.error || 'Recovery failed.';
      errorEl.hidden = false;
      return;
    }

    // Store the recovered token
    localStorage.setItem(STORAGE_KEYS.subToken, data.subToken);

    closeModal('recover-modal');
    loadAccountStatus();
    loadModels();

    alert(`Account recovered! Plan: ${data.plan}`);

  } catch (err) {
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.hidden = false;
  }
}

// ============================================================
// 9. MODAL HELPERS
// ============================================================

function showModal(id) {
  document.getElementById(id).hidden = false;
  document.getElementById('modal-backdrop').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
  // Hide backdrop only if no other modals are open
  const anyOpen = document.querySelectorAll('.modal:not([hidden])').length > 0;
  document.getElementById('modal-backdrop').hidden = !anyOpen;
  if (!anyOpen) document.body.style.overflow = '';
}

function showUpgradeModal() {
  showModal('upgrade-modal');
}

// ============================================================
// 10. EVENT LISTENERS + BOOT
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // --- Identity ---
  initIdentity();

  // --- Load from Stripe redirect if returning from checkout ---
  handleCheckoutReturn();

  // --- Load history and render ---
  const history = loadHistory();
  if (history.length > 0) renderHistory(history);

  // --- Load account status + models ---
  loadAccountStatus();
  loadModels();

  // --- Chat form submit ---
  const form = document.getElementById('chat-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('message-input');
    const text  = input.value;
    input.value = '';
    input.style.height = 'auto'; // reset auto-grow
    sendMessage(text);
  });

  // --- Textarea: submit on Enter (not Shift+Enter) ---
  document.getElementById('message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

  // --- Auto-grow textarea ---
  document.getElementById('message-input').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  });

  // --- Upgrade button ---
  document.getElementById('upgrade-btn').addEventListener('click', showUpgradeModal);

  // --- Plan selection in upgrade modal ---
  document.querySelectorAll('.upgrade-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const plan = btn.closest('.plan-card').dataset.plan;
      closeModal('upgrade-modal');
      startCheckout(plan);
    });
  });

  // --- Recover account button ---
  document.getElementById('recover-btn').addEventListener('click', () => {
    showModal('recover-modal');
  });

  document.getElementById('recover-submit-btn').addEventListener('click', recoverAccount);

  // --- Copy recovery key ---
  document.getElementById('copy-recovery-btn').addEventListener('click', () => {
    const key = document.getElementById('recovery-key-display').textContent;
    navigator.clipboard.writeText(key).then(() => {
      document.getElementById('copy-recovery-btn').textContent = 'Copied!';
      setTimeout(() => {
        document.getElementById('copy-recovery-btn').textContent = 'Copy Key';
      }, 2000);
    });
  });

  // --- Clear history ---
  document.getElementById('clear-history-btn').addEventListener('click', () => {
    if (!confirm('Clear all chat history? This cannot be undone.')) return;
    localStorage.removeItem(STORAGE_KEYS.chatHistory);
    const container = document.getElementById('chat-messages');
    const systemMsg = container.querySelector('.system-message');
    container.innerHTML = '';
    if (systemMsg) container.appendChild(systemMsg);
  });

  // --- Close modals ---
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });

  // --- Close modal by clicking backdrop ---
  document.getElementById('modal-backdrop').addEventListener('click', () => {
    document.querySelectorAll('.modal:not([hidden])').forEach(m => {
      // Don't close the recovery key modal on backdrop click — user must confirm they saved it
      if (m.id !== 'recovery-modal') closeModal(m.id);
    });
  });
});
