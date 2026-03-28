require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Stripe — initialised lazily so the app still boots without a real key
// ---------------------------------------------------------------------------
let stripe = null;
function getStripe() {
  if (!stripe && process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors());

// Stripe webhooks need the raw body — must come BEFORE express.json()
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// Parse JSON for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Telegram helper
// ---------------------------------------------------------------------------
async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId || token.includes('placeholder') || chatId.includes('placeholder')) {
    console.log('[Telegram] Skipping (not configured):', message);
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] API error:', data);
    }
    return data;
  } catch (err) {
    console.error('[Telegram] Send error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/demo-request  — phone number submission
// ---------------------------------------------------------------------------
app.post('/api/demo-request', async (req, res) => {
  try {
    const { phone, name, business } = req.body;

    if (!phone || phone.trim().length < 7) {
      return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
    }

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Toronto',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    // Log to console
    console.log(`[Demo Request] Phone: ${phone} | Name: ${name || 'N/A'} | Business: ${business || 'N/A'} | Time: ${timestamp}`);

    // Send Telegram notification
    let tgMsg = `📞 <b>New JARVIS demo request!</b>\n\nNumber: <code>${phone}</code>`;
    if (name) tgMsg += `\nName: ${name}`;
    if (business) tgMsg += `\nBusiness: ${business}`;
    tgMsg += `\nTime: ${timestamp}`;

    await sendTelegramMessage(tgMsg);

    return res.json({ success: true, message: 'Demo request received! We will call you shortly.' });
  } catch (err) {
    console.error('[Demo Request] Error:', err);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/create-checkout — create Stripe Checkout session
// ---------------------------------------------------------------------------
app.post('/api/create-checkout', async (req, res) => {
  try {
    const s = getStripe();
    if (!s) {
      return res.status(503).json({
        success: false,
        error: 'Stripe is not configured yet. Please set STRIPE_SECRET_KEY.',
      });
    }

    const { name, email, phone, business } = req.body;

    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      currency: 'cad',
      line_items: [
        {
          price_data: {
            currency: 'cad',
            product_data: {
              name: 'JARVIS AI Setup Deposit',
              description: 'Custom AI voice receptionist setup for your business. Fully configured, tested, and deployed.',
            },
            unit_amount: 29700, // $297.00 CAD in cents
          },
          quantity: 1,
        },
      ],
      customer_email: email || undefined,
      metadata: {
        customer_name: name || '',
        customer_phone: phone || '',
        business_name: business || '',
      },
      success_url: `${appUrl}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/#pricing`,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    console.error('[Checkout] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/webhook/stripe — Stripe webhook handler
// ---------------------------------------------------------------------------
async function handleStripeWebhook(req, res) {
  const s = getStripe();
  if (!s) {
    console.log('[Webhook] Stripe not configured — ignoring.');
    return res.status(200).send('ok');
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret && !webhookSecret.includes('placeholder')) {
      event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // In dev / without webhook secret, parse the body directly
      event = JSON.parse(req.body.toString());
      console.log('[Webhook] No webhook secret — parsing body directly (dev mode).');
    }
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const amount = ((session.amount_total || 0) / 100).toFixed(2);
    const currency = (session.currency || 'cad').toUpperCase();
    const customerName = session.metadata?.customer_name || session.customer_details?.name || 'Unknown';
    const email = session.customer_details?.email || session.metadata?.customer_email || 'Unknown';
    const business = session.metadata?.business_name || 'N/A';
    const phone = session.metadata?.customer_phone || 'N/A';

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Toronto',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    console.log(`[Payment] $${amount} ${currency} from ${customerName} (${email}) — Business: ${business}`);

    const tgMsg = `💰 <b>New deposit received!</b>\n\nAmount: $${amount} ${currency}\nName: ${customerName}\nEmail: <code>${email}</code>\nPhone: <code>${phone}</code>\nBusiness: ${business}\nTime: ${timestamp}`;

    await sendTelegramMessage(tgMsg);
  }

  return res.status(200).json({ received: true });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'JARVIS AI',
    timestamp: new Date().toISOString(),
    stripe: !!getStripe(),
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('placeholder')),
  });
});

// ---------------------------------------------------------------------------
// SPA fallback — serve index.html for any unmatched route
// ---------------------------------------------------------------------------
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🤖 JARVIS AI server running on port ${PORT}`);
  console.log(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Stripe      : ${getStripe() ? '✅ connected' : '⚠️  not configured'}`);
  console.log(`   Telegram    : ${process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('placeholder') ? '✅ connected' : '⚠️  not configured'}\n`);
});
