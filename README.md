# Privacy-First AI Chat App

## Folder Structure

```
privacy-chat/
├── src/
│   ├── routes/
│   │   ├── chat.js          # OpenRouter relay endpoint
│   │   ├── billing.js       # Stripe Checkout + portal routes
│   │   └── account.js       # Account recovery routes
│   ├── middleware/
│   │   └── auth.js          # Subscription token validation
│   └── services/
│       └── supabase.js      # Supabase client (billing data only)
├── public/
│   ├── index.html           # Main chat UI
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── app.js           # Frontend logic (UID gen, chat, billing)
├── server.js                # Express entry point
├── .env                     # Environment variables (never commit this)
├── .env.example             # Safe template to commit
└── package.json
```

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in your keys
3. `node server.js` (dev) or deploy to Hostinger

## Stripe CLI for local webhook testing

```bash
stripe listen --forward-to localhost:3000/webhook/stripe
```
