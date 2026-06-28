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
    const isMinorMode   = document.body.dataset.mode === 'minor';

    // "No-training models only" is forced on automatically in minor
    // mode (better default for a young person's data), otherwise it
    // reflects whatever the user picked in the privacy radio toggle.
    const noTrainRadio = document.querySelector('input[name="data-policy"]:checked');
    const noTrainOnly  = isMinorMode || (noTrainRadio && noTrainRadio.value === 'no-train');

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
        messages:    history,          // full conversation context
        model:       selectedModel,
        noTrainOnly: noTrainOnly,
        minorMode:   isMinorMode,
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

    // Update plan badge (teen.html keeps its own "Teen Mode" label
    // rather than showing the underlying free-tier plan name)
    const badge = document.getElementById('plan-badge');
    if (document.body.dataset.mode !== 'minor') {
      const planNames = { free: 'Free', pro50: 'Pro 50', pro100: 'Pro 100', pro200: 'Pro 200' };
      badge.textContent = planNames[data.plan] || data.plan;
      badge.className   = `plan-badge plan-${data.plan}`;
    }

    // Update usage info
    const usageEl = document.getElementById('usage-info');
    if (data.requestsToday !== undefined) {
      const limit = data.limits?.requestsPerDay;
      usageEl.textContent = `${data.requestsToday} / ${limit} requests today`;
    }

    // Cache plan locally
    localStorage.setItem(STORAGE_KEYS.plan, data.plan);

    // Show/hide upgrade button (never shown in minor mode — see DOMContentLoaded)
    if (document.body.dataset.mode !== 'minor') {
      document.getElementById('upgrade-btn').hidden = data.plan === 'pro200';
    }

  } catch (err) {
    console.error('[status] Could not load account status:', err.message);
  }
}

// ============================================================
// 6. MODEL LIST — custom dropdown with provider logos
// ============================================================
// Native <select><option> elements can't render an <img>/<span> logo
// inside them, so the model picker is a button + popover list built
// here instead. The hidden #model-select input still holds "the
// selected model" so the rest of the app (sendMessage, etc.) doesn't
// need to know about this.

const FREE_MODELS_VISIBLE_BY_DEFAULT = 2;
const FLAGSHIP_MODELS_VISIBLE_BY_DEFAULT = 5;
let freeModelsExpanded = false;
let flagshipModelsExpanded = false;
let lastModelsResponse = null; // cached so "show more" can re-render without refetching

// Generic monogram badge for a provider. Deliberately NOT an official
// brand logo (see the CSS comment on .model-logo for why). Swap these
// for <img> tags if you obtain official logos under each company's
// brand guidelines.
function providerLogoHTML(provider) {
  const letter = { openai: 'O', google: 'G', anthropic: 'A' }[provider] || '?';
  return `<span class="model-logo ${provider || 'free'}" aria-hidden="true">${letter}</span>`;
}

async function loadModels() {
  const pickerLabel = document.getElementById('model-picker-selected');

  // Give the request a hard timeout so a slow/stalled server response
  // shows up as a visible, retryable error instead of leaving the
  // button stuck on "Loading models..." forever with no feedback.
  const controller = new AbortController();
  const timeoutId   = setTimeout(() => controller.abort(), 10000);

  try {
    const subToken  = localStorage.getItem(STORAGE_KEYS.subToken) || 'free';
    const isMinor    = document.body.dataset.mode === 'minor';
    const query      = isMinor ? '?minorMode=true' : '';

    const response = await fetch(`/api/chat/models${query}`, {
      headers: { 'Authorization': `Bearer ${subToken}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[models] Server returned ${response.status} for /api/chat/models`);
      showModelLoadError(pickerLabel, `Couldn't load models (${response.status}) — tap to retry`);
      return;
    }

    const data = await response.json();
    lastModelsResponse = data;
    delete document.getElementById('model-picker-btn')?.dataset.loadFailed;
    renderModelPicker(data);

  } catch (err) {
    const message = err.name === 'AbortError'
      ? "Request timed out — tap to retry"
      : "Couldn't load models — tap to retry";
    console.error('[models] Could not load models:', err.message);
    showModelLoadError(pickerLabel, message);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Shows a clickable error state in the model picker button instead of
// leaving it stuck on "Loading models..." with no feedback. The
// existing click handler on this button (wired in DOMContentLoaded)
// checks data-load-failed and retries instead of opening the (empty)
// dropdown when this is set.
function showModelLoadError(labelEl, message) {
  if (!labelEl) return;
  labelEl.textContent = message;
  const btn = document.getElementById('model-picker-btn');
  if (btn) btn.dataset.loadFailed = 'true';
}

function renderModelPicker(data) {
  const panel = document.getElementById('model-picker-panel');
  const hiddenInput = document.getElementById('model-select');
  const { flagship = [], free = [] } = data;

  let html = '';

  // ---- Flagship section (latest OpenAI / Gemini / Claude models) ----
  if (flagship.length) {
    html += `<div class="model-group-label">Flagship models</div>`;
    const flagshipVisibleCount = flagshipModelsExpanded
      ? flagship.length
      : Math.min(FLAGSHIP_MODELS_VISIBLE_BY_DEFAULT, flagship.length);

    flagship.slice(0, flagshipVisibleCount).forEach(m => {
      const isSelected = hiddenInput.value === m.id;
      const lockNote = m.locked
        ? `<span class="model-row-lock">Upgrade to ${planLabel(m.requiredPlan)}</span>`
        : '';
      html += `
        <div class="model-row ${m.locked ? 'locked' : ''} ${isSelected ? 'selected' : ''}"
             data-model-id="${m.id}" data-locked="${!!m.locked}" role="option" tabindex="0">
          ${providerLogoHTML(m.provider)}
          <span class="model-row-name">${m.name}</span>
          ${lockNote}
        </div>`;
    });

    if (!flagshipModelsExpanded && flagship.length > FLAGSHIP_MODELS_VISIBLE_BY_DEFAULT) {
      html += `<button type="button" class="model-show-more" id="show-more-flagship-btn">
        Show ${flagship.length - FLAGSHIP_MODELS_VISIBLE_BY_DEFAULT} more flagship models
      </button>`;
    }
  }

  // ---- Free section (dynamic — first 2, with "show more") ----
  if (free.length) {
    html += `<div class="model-group-label">Free models</div>`;
    const visibleCount = freeModelsExpanded ? free.length : Math.min(FREE_MODELS_VISIBLE_BY_DEFAULT, free.length);

    free.slice(0, visibleCount).forEach(m => {
      const isSelected = hiddenInput.value === m.id;
      html += `
        <div class="model-row ${isSelected ? 'selected' : ''}"
             data-model-id="${m.id}" data-locked="false" role="option" tabindex="0">
          ${providerLogoHTML('free')}
          <span class="model-row-name">${m.name}</span>
        </div>`;
    });

    if (!freeModelsExpanded && free.length > FREE_MODELS_VISIBLE_BY_DEFAULT) {
      html += `<button type="button" class="model-show-more" id="show-more-free-btn">
        Show ${free.length - FREE_MODELS_VISIBLE_BY_DEFAULT} more free models
      </button>`;
    }
  }

  panel.innerHTML = html || '<div class="model-group-label">No models available</div>';

  // Wire up row clicks
  panel.querySelectorAll('.model-row').forEach(row => {
    row.addEventListener('click', () => onModelRowClick(row));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onModelRowClick(row); }
    });
  });

  const showMoreFreeBtn = document.getElementById('show-more-free-btn');
  if (showMoreFreeBtn) {
    showMoreFreeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      freeModelsExpanded = true;
      renderModelPicker(lastModelsResponse);
    });
  }

  const showMoreFlagshipBtn = document.getElementById('show-more-flagship-btn');
  if (showMoreFlagshipBtn) {
    showMoreFlagshipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      flagshipModelsExpanded = true;
      renderModelPicker(lastModelsResponse);
    });
  }

  // Pick a sensible default selection if nothing is selected yet
  if (!hiddenInput.value) {
    const firstUnlocked = flagship.find(m => !m.locked) || free[0];
    if (firstUnlocked) selectModel(firstUnlocked.id, firstUnlocked.name);
  } else {
    // Keep the button label in sync with whatever's already selected
    const current = [...flagship, ...free].find(m => m.id === hiddenInput.value);
    if (current) document.getElementById('model-picker-selected').textContent = current.name;
  }
}

function onModelRowClick(row) {
  const modelId = row.dataset.modelId;
  const locked  = row.dataset.locked === 'true';

  if (locked) {
    closeModelPicker();
    showUpgradeModal();
    return;
  }

  const name = row.querySelector('.model-row-name').textContent;
  selectModel(modelId, name);
  closeModelPicker();
}

function selectModel(id, name) {
  document.getElementById('model-select').value = id;
  document.getElementById('model-picker-selected').textContent = name;
  // Re-render so the "selected" highlight moves to the new row
  if (lastModelsResponse) renderModelPicker(lastModelsResponse);
}

function planLabel(plan) {
  return { free: 'Free', pro50: 'Pro 50', pro100: 'Pro 100', pro200: 'Pro 200' }[plan] || plan;
}

function toggleModelPicker() {
  const panel = document.getElementById('model-picker-panel');
  const btn   = document.getElementById('model-picker-btn');
  const isOpen = !panel.hidden;
  panel.hidden = isOpen;
  btn.setAttribute('aria-expanded', String(!isOpen));
}

function closeModelPicker() {
  document.getElementById('model-picker-panel').hidden = true;
  document.getElementById('model-picker-btn').setAttribute('aria-expanded', 'false');
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

      // Show recovery key modal if we have one (no-op on pages without
      // a recovery modal, e.g. teen.html)
      const recoveryDisplay = document.getElementById('recovery-key-display');
      if (pendingRecKey && recoveryDisplay) {
        recoveryDisplay.textContent = pendingRecKey;
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

  // --- Minor mode UI adjustments ---
  // teen.html sets <body data-mode="minor">. In that mode we hide
  // billing/upgrade/recovery (no commerce flows on a minors-focused
  // page) and the privacy radio (no-train routing is forced on
  // automatically server-side for minor-mode requests regardless).
  if (document.body.dataset.mode === 'minor') {
    const upgradeBtn   = document.getElementById('upgrade-btn');
    const recoverBtn   = document.getElementById('recover-btn');
    const privacyToggle = document.querySelector('.privacy-toggle');
    if (upgradeBtn)    upgradeBtn.hidden = true;
    if (recoverBtn)    recoverBtn.hidden = true;
    if (privacyToggle) privacyToggle.hidden = true;
  }

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

  // --- Upgrade button (not present on teen.html by design) ---
  document.getElementById('upgrade-btn')?.addEventListener('click', showUpgradeModal);

  // --- Model picker dropdown ---
  document.getElementById('model-picker-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.dataset.loadFailed === 'true') {
      delete btn.dataset.loadFailed;
      document.getElementById('model-picker-selected').textContent = 'Loading models…';
      loadModels();
      return;
    }
    toggleModelPicker();
  });
  document.addEventListener('click', (e) => {
    const picker = document.querySelector('.model-picker');
    if (picker && !picker.contains(e.target)) closeModelPicker();
  });

  // --- Privacy toggle: re-send isn't needed, sendMessage reads the radio live ---

  // --- Plan selection in upgrade modal (no-op on teen.html — empty list) ---
  document.querySelectorAll('.upgrade-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const plan = btn.closest('.plan-card').dataset.plan;
      closeModal('upgrade-modal');
      startCheckout(plan);
    });
  });

  // --- Recover account button (not present on teen.html by design) ---
  document.getElementById('recover-btn')?.addEventListener('click', () => {
    showModal('recover-modal');
  });

  document.getElementById('recover-submit-btn')?.addEventListener('click', recoverAccount);


  // --- Copy recovery key ---
  // --- Copy recovery key (not present on teen.html by design) ---
  document.getElementById('copy-recovery-btn')?.addEventListener('click', () => {
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
