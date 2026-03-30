require('dotenv').config();

const express = require('express');
const path    = require('path');
const cors    = require('cors');
const helmet  = require('helmet');
const fetch   = require('node-fetch');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Data directory — create on startup if missing
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  usedNumbers : path.join(DATA_DIR, 'used_numbers.json'),
  usedIPs     : path.join(DATA_DIR, 'used_ips.json'),
  blocked     : path.join(DATA_DIR, 'blocked_attempts.json'),
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [, filePath] of Object.entries(FILES)) {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
  }
}
ensureDataDir();

// ---------------------------------------------------------------------------
// Persistent store helpers
// ---------------------------------------------------------------------------
function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Store] Write error (${filePath}):`, err.message);
  }
}

// ---------------------------------------------------------------------------
// In-memory rate-limit store  { ip -> [timestamp, timestamp, ...] }
// ---------------------------------------------------------------------------
const rateLimitStore = new Map();
const RATE_LIMIT_MAX     = 3;   // max requests
const RATE_LIMIT_WINDOW  = 60 * 60 * 1000; // 1 hour in ms
const COOLDOWN_DAYS      = 30;
const COOLDOWN_MS        = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

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
// Utility: get real client IP (handles proxies / Railway / Render)
// ---------------------------------------------------------------------------
function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ---------------------------------------------------------------------------
// Utility: mask phone number for logging  e.g. "+1 416 555 1234" → "***-***-1234"
// ---------------------------------------------------------------------------
function maskPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***-***-${digits.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Utility: normalise phone to 10 digits (strips country code +1 / 1)
// ---------------------------------------------------------------------------
function normalisePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  // Strip leading country code 1 if 11 digits
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

// ---------------------------------------------------------------------------
// Phone validation
// ---------------------------------------------------------------------------
const FAKE_PATTERNS = [
  /^(\d)\1{9}$/,                    // all same digit: 1111111111
  /^1234567890$/,                   // ascending sequence
  /^0987654321$/,                   // descending sequence
  /^1231231234$/,                   // repeating triplet
  /^0{10}$/,                        // all zeros
  /^1{10}$/,                        // all ones (already caught above but explicit)
];

// NANP area codes that are unassigned / invalid
const INVALID_AREA_CODES = new Set([
  '000', '100', '200', '300', '400', '500', '600', '700', '800', '900',
]);

function validatePhone(raw) {
  const normalised = normalisePhone(raw);

  if (normalised.length !== 10) {
    return { valid: false, reason: 'Phone number must be 10 digits (US or Canadian).' };
  }

  const areaCode = normalised.slice(0, 3);
  if (INVALID_AREA_CODES.has(areaCode)) {
    return { valid: false, reason: 'Invalid area code.' };
  }

  // Area code and exchange cannot start with 0 or 1 (NANP rule)
  if (areaCode[0] === '0' || areaCode[0] === '1') {
    return { valid: false, reason: 'Invalid US/Canadian area code.' };
  }

  const exchange = normalised.slice(3, 6);
  if (exchange[0] === '0' || exchange[0] === '1') {
    return { valid: false, reason: 'Invalid phone number format.' };
  }

  for (const pattern of FAKE_PATTERNS) {
    if (pattern.test(normalised)) {
      return { valid: false, reason: 'Please enter a valid US or Canadian phone number.' };
    }
  }

  return { valid: true, normalised };
}

// ---------------------------------------------------------------------------
// Log a blocked attempt to ./data/blocked_attempts.json
// ---------------------------------------------------------------------------
function logBlockedAttempt({ ip, phone, reason }) {
  const attempts = readJSON(FILES.blocked);
  attempts.push({
    timestamp : new Date().toISOString(),
    ip,
    phone     : phone ? maskPhone(phone) : 'N/A',
    reason,
  });
  // Keep last 1 000 entries to avoid unbounded growth
  if (attempts.length > 1000) attempts.splice(0, attempts.length - 1000);
  writeJSON(FILES.blocked, attempts);
}

// ---------------------------------------------------------------------------
// Rate-limit check  (in-memory, resets on server restart)
// ---------------------------------------------------------------------------
function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimitStore.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(ip, timestamps);
    return { allowed: false };
  }
  timestamps.push(now);
  rateLimitStore.set(ip, timestamps);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// IP one-call check  (persistent)
// ---------------------------------------------------------------------------
function checkIP(ip) {
  const records = readJSON(FILES.usedIPs);
  const entry   = records.find(r => r.ip === ip);
  if (!entry) return { allowed: true };

  const age = Date.now() - new Date(entry.usedAt).getTime();
  if (age < COOLDOWN_MS) {
    const daysLeft = Math.ceil((COOLDOWN_MS - age) / (24 * 60 * 60 * 1000));
    return { allowed: false, daysLeft };
  }
  // Cooldown expired — remove the old entry so they can try again
  const updated = records.filter(r => r.ip !== ip);
  writeJSON(FILES.usedIPs, updated);
  return { allowed: true };
}

function recordIP(ip) {
  const records = readJSON(FILES.usedIPs);
  records.push({ ip, usedAt: new Date().toISOString() });
  writeJSON(FILES.usedIPs, records);
}

// ---------------------------------------------------------------------------
// Phone one-call check  (persistent, 30-day cooldown)
// ---------------------------------------------------------------------------
function checkPhone(normalised) {
  const records = readJSON(FILES.usedNumbers);
  const entry   = records.find(r => r.phone === normalised);
  if (!entry) return { allowed: true };

  const age = Date.now() - new Date(entry.usedAt).getTime();
  if (age < COOLDOWN_MS) {
    const daysLeft = Math.ceil((COOLDOWN_MS - age) / (24 * 60 * 60 * 1000));
    return { allowed: false, daysLeft };
  }
  // Cooldown expired
  const updated = records.filter(r => r.phone !== normalised);
  writeJSON(FILES.usedNumbers, updated);
  return { allowed: true };
}

function recordPhone(normalised) {
  const records = readJSON(FILES.usedNumbers);
  records.push({ phone: normalised, usedAt: new Date().toISOString() });
  writeJSON(FILES.usedNumbers, records);
}

// ---------------------------------------------------------------------------
// Telegram helper
// ---------------------------------------------------------------------------
async function sendTelegramMessage(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId || token.includes('placeholder') || chatId.includes('placeholder')) {
    console.log('[Telegram] Skipping (not configured):', message);
    return { ok: false, reason: 'not_configured' };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[Telegram] API error:', data);
    return data;
  } catch (err) {
    console.error('[Telegram] Send error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/demo-request  — phone number submission with full abuse prevention
// ---------------------------------------------------------------------------
app.post('/api/demo-request', async (req, res) => {
  const ip = getClientIP(req);

  try {
    const { phone, name, business } = req.body;

    // ── 1. Basic presence check ──────────────────────────────────────────────
    if (!phone || String(phone).trim().length < 7) {
      return res.status(400).json({
        success : false,
        code    : 'MISSING_PHONE',
        error   : 'A phone number is required.',
      });
    }

    const rawPhone = String(phone).trim();

    // ── 2. Phone format & fake-number validation ─────────────────────────────
    const phoneCheck = validatePhone(rawPhone);
    if (!phoneCheck.valid) {
      logBlockedAttempt({ ip, phone: rawPhone, reason: `INVALID_PHONE: ${phoneCheck.reason}` });
      return res.status(400).json({
        success : false,
        code    : 'INVALID_PHONE',
        error   : 'Please enter a valid US or Canadian phone number.',
      });
    }

    const { normalised } = phoneCheck;

    // ── 3. Rate limit (3 requests / IP / hour) ───────────────────────────────
    const rateCheck = checkRateLimit(ip);
    if (!rateCheck.allowed) {
      logBlockedAttempt({ ip, phone: rawPhone, reason: 'RATE_LIMIT_EXCEEDED' });
      return res.status(429).json({
        success : false,
        code    : 'RATE_LIMIT',
        error   : 'Too many requests. Please try again later.',
      });
    }

    // ── 4. One-call-per-IP (30-day cooldown) ─────────────────────────────────
    const ipCheck = checkIP(ip);
    if (!ipCheck.allowed) {
      logBlockedAttempt({ ip, phone: rawPhone, reason: `IP_ALREADY_USED (${ipCheck.daysLeft}d left)` });
      return res.status(429).json({
        success  : false,
        code     : 'IP_ALREADY_USED',
        error    : `This device has already received a free demo. Please contact us to get started.`,
        daysLeft : ipCheck.daysLeft,
      });
    }

    // ── 5. One-call-per-phone (30-day cooldown) ───────────────────────────────
    const phoneUsedCheck = checkPhone(normalised);
    if (!phoneUsedCheck.allowed) {
      logBlockedAttempt({ ip, phone: rawPhone, reason: `PHONE_ALREADY_USED (${phoneUsedCheck.daysLeft}d left)` });
      return res.status(429).json({
        success  : false,
        code     : 'PHONE_ALREADY_USED',
        error    : 'This number has already received a free demo. Please contact us to get started.',
        daysLeft : phoneUsedCheck.daysLeft,
      });
    }

    // ── 6. All checks passed — record usage ──────────────────────────────────
    recordPhone(normalised);
    recordIP(ip);

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone  : 'America/Toronto',
      dateStyle : 'medium',
      timeStyle : 'short',
    });

    console.log(`[Demo Request] ✅ Phone: ${maskPhone(rawPhone)} | Name: ${name || 'N/A'} | Business: ${business || 'N/A'} | IP: ${ip} | Time: ${timestamp}`);

    // Send Telegram notification
    let tgMsg = `📞 <b>New JARVIS demo request!</b>\n\nNumber: <code>${maskPhone(rawPhone)}</code>`;
    if (name)     tgMsg += `\nName: ${name}`;
    if (business) tgMsg += `\nBusiness: ${business}`;
    tgMsg += `\nTime: ${timestamp}`;

    await sendTelegramMessage(tgMsg);

    return res.json({
      success : true,
      message : 'Demo request received! We will call you shortly.',
    });

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
        success : false,
        error   : 'Stripe is not configured yet. Please set STRIPE_SECRET_KEY.',
      });
    }

    const { name, email, phone, business } = req.body;
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    const session = await s.checkout.sessions.create({
      payment_method_types : ['card'],
      mode                 : 'payment',
      currency             : 'usd',
      line_items: [
        {
          price_data: {
            currency     : 'usd',
            product_data : {
              name        : 'JARVIS AI Receptionist — Setup Deposit',
              description : 'Custom AI voice receptionist setup for your business. Fully configured, tested, and deployed.',
            },
            unit_amount : 49700, // $497.00 USD in cents
          },
          quantity : 1,
        },
      ],
      customer_email : email || undefined,
      metadata: {
        customer_name  : name     || '',
        customer_phone : phone    || '',
        business_name  : business || '',
      },
      success_url : `${appUrl}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url  : `${appUrl}/#pricing`,
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

  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    if (webhookSecret && !webhookSecret.includes('placeholder')) {
      event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
      console.log('[Webhook] No webhook secret — parsing body directly (dev mode).');
    }
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session      = event.data.object;
    const amount       = ((session.amount_total || 0) / 100).toFixed(2);
    const currency     = (session.currency || 'cad').toUpperCase();
    const customerName = session.metadata?.customer_name || session.customer_details?.name || 'Unknown';
    const email        = session.customer_details?.email || session.metadata?.customer_email || 'Unknown';
    const business     = session.metadata?.business_name || 'N/A';
    const phone        = session.metadata?.customer_phone || 'N/A';

    const timestamp = new Date().toLocaleString('en-US', {
      timeZone  : 'America/Toronto',
      dateStyle : 'medium',
      timeStyle : 'short',
    });

    console.log(`[Payment] $${amount} ${currency} from ${customerName} (${email}) — Business: ${business}`);

    const tgMsg = `💰 <b>New deposit received!</b>\n\nAmount: $${amount} ${currency}\nName: ${customerName}\nEmail: <code>${email}</code>\nPhone: <code>${phone}</code>\nBusiness: ${business}\nTime: ${timestamp}`;
    await sendTelegramMessage(tgMsg);
  }

  return res.status(200).json({ received: true });
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  const usedNumbers = readJSON(FILES.usedNumbers).length;
  const usedIPs     = readJSON(FILES.usedIPs).length;
  const blocked     = readJSON(FILES.blocked).length;

  res.json({
    status       : 'ok',
    service      : 'JARVIS AI',
    timestamp    : new Date().toISOString(),
    stripe       : !!getStripe(),
    telegram     : !!(process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('placeholder')),
    abuse_stats  : { used_numbers: usedNumbers, used_ips: usedIPs, blocked_attempts: blocked },
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/blocked  — view blocked attempts (basic)
// ---------------------------------------------------------------------------
app.get('/api/admin/blocked', (req, res) => {
  const attempts = readJSON(FILES.blocked);
  res.json({ count: attempts.length, attempts: attempts.slice(-50) }); // last 50
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
  console.log(`   Telegram    : ${process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('placeholder') ? '✅ connected' : '⚠️  not configured'}`);
  console.log(`   Data dir    : ${DATA_DIR}\n`);
});
