# Hostinger Deployment Checklist

Hostinger Business Web Hosting runs Node.js via their Node.js manager
in hPanel. Here's how to deploy.

## Prerequisites
- Node.js app set up in hPanel (hPanel > Hosting > Node.js)
- Domain pointed to hosting
- SSL certificate active (Let's Encrypt, free in hPanel)

## Steps

### 1. Upload your files
Using Hostinger's File Manager or SSH:
```bash
# Via SSH (Hostinger provides SSH access on Business plans)
scp -r ./privacy-chat your-user@your-server.hostinger.com:~/apps/privacy-chat
```

Or use the File Manager to upload a ZIP and extract it.

### 2. Set environment variables
In hPanel > Node.js > your app > Environment Variables, add each line from .env:
- OPENROUTER_API_KEY
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_50, STRIPE_PRICE_100, STRIPE_PRICE_200
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- APP_SECRET
- APP_URL  (set to https://yourdomain.com)
- NODE_ENV=production

### 3. Install dependencies
In hPanel terminal or SSH:
```bash
cd ~/apps/privacy-chat
npm install --omit=dev
```

### 4. Set startup file
In hPanel > Node.js, set:
- Application root: /home/yourusername/apps/privacy-chat
- Startup file: server.js

### 5. Set up Stripe webhook
In Stripe Dashboard > Developers > Webhooks > Add endpoint:
- URL: https://yourdomain.com/webhook/stripe
- Events to listen for:
  - checkout.session.completed
  - invoice.payment_succeeded
  - customer.subscription.deleted

Copy the "Signing secret" → set as STRIPE_WEBHOOK_SECRET in env vars.

### 6. Test
- Visit https://yourdomain.com — chat should work on free tier
- Click Upgrade → Stripe Checkout should open
- Use Stripe's test card 4242 4242 4242 4242 to test payment

### 7. Production security checklist
- [ ] APP_SECRET is a long random string (not the example value)
- [ ] NODE_ENV=production
- [ ] .env file is NOT in your public folder
- [ ] SSL is active (https)
- [ ] Stripe keys are LIVE keys (not test) before going live
