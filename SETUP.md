# JARVIS AI — Deployment & Configuration Guide

Welcome to the **JARVIS AI** demo funnel setup guide. This document provides step-by-step instructions on how to configure your payment processor (Stripe), set up lead notifications (Telegram), and deploy the application to a live server.

---

## 1. Stripe Configuration

To accept the $297 CAD setup deposit, you need to configure Stripe and obtain your API keys.

### Step 1: Create a Stripe Account
1. Go to [Stripe.com](https://stripe.com/) and sign up for a free account.
2. Verify your email address and log in to the Stripe Dashboard.

### Step 2: Connect Your Bank Account (Canada)
1. In the Stripe Dashboard, navigate to **Settings** (gear icon in the top right) > **Business settings** > **Bank accounts and scheduling**.
2. Click **Add bank account**.
3. Enter your Canadian transit number, institution number, and account number.
4. Save the details to enable payouts to your bank.

### Step 3: Get Your API Keys
1. In the Stripe Dashboard, go to the **Developers** section (top right).
2. Click on the **API keys** tab.
3. Under **Standard keys**, you will see your **Publishable key** and **Secret key**.
4. **Important**: While testing, ensure the "Test mode" toggle (top right) is **ON**. Your keys will start with `pk_test_` and `sk_test_`.
5. Copy the **Secret key** (`sk_test_...`) — you will need this for the `STRIPE_SECRET_KEY` environment variable.

### Step 4: Switch to Live Mode (When Ready)
1. Once you have tested the funnel and are ready to accept real payments, toggle "Test mode" to **OFF** in the Stripe Dashboard.
2. Go back to the **API keys** tab and copy your new live **Secret key** (`sk_live_...`).
3. Update the `STRIPE_SECRET_KEY` environment variable on your hosting platform with this live key.

---

## 2. Telegram Notification Setup

The backend uses a Telegram bot to send you instant notifications when a user requests a demo or completes a payment.

### Step 1: Create a Telegram Bot
1. Open the Telegram app and search for the **BotFather** (`@BotFather`).
2. Send the message `/newbot` to create a new bot.
3. Follow the prompts to choose a name (e.g., "JARVIS Leads") and a username (e.g., `jarvis_leads_bot`).
4. BotFather will give you an **HTTP API Token** (e.g., `123456789:ABCdefGHIjklmNOPqrstUVwxyZ`). Copy this token — this is your `TELEGRAM_BOT_TOKEN`.

### Step 2: Get Your Chat ID
1. Search for the **userinfobot** (`@userinfobot`) in Telegram.
2. Send the message `/start`.
3. The bot will reply with your user ID (a string of numbers, e.g., `987654321`). Copy this number — this is your `TELEGRAM_CHAT_ID`.

### Step 3: Start Your Bot
1. Search for the bot you created in Step 1 using its username.
2. Open the chat and click **Start** (or send `/start`). The bot must be started by you before it can send you messages.

---

## 3. Deployment Guide

You can deploy this application easily to any modern hosting platform. Below are instructions for **Railway**, which is highly recommended for Node.js apps.

### Option A: Deploying to Railway (Recommended)

1. **Create a GitHub Repository**:
   - Create a new private repository on GitHub.
   - Push the contents of the `jarvis-ai-source.zip` file to this repository.

2. **Connect to Railway**:
   - Go to [Railway.app](https://railway.app/) and sign in.
   - Click **New Project** > **Deploy from GitHub repo**.
   - Select the repository you just created.
   - Railway will automatically detect the Node.js environment and start building.

3. **Set Environment Variables**:
   - In your Railway project dashboard, click on the deployed service.
   - Go to the **Variables** tab.
   - Add the following environment variables:
     - `NODE_ENV`: `production`
     - `STRIPE_SECRET_KEY`: Your Stripe secret key (test or live)
     - `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
     - `TELEGRAM_CHAT_ID`: Your Telegram chat ID
     - `APP_URL`: Your Railway deployment URL (e.g., `https://your-app-name.up.railway.app`)

4. **Generate a Domain**:
   - Go to the **Settings** tab in your Railway service.
   - Under **Networking**, click **Generate Domain** to get a public URL for your funnel.
   - Make sure to update the `APP_URL` variable with this domain.

### Option B: Deploying to Render.com (Free Tier Available)

1. Push your code to GitHub.
2. Go to [Render.com](https://render.com/) and sign in.
3. Click **New +** > **Web Service**.
4. Connect your GitHub repository.
5. Render will automatically detect the `render.yaml` file included in the source code and configure the deployment.
6. In the Render dashboard, go to the **Environment** tab and fill in the required variables (`STRIPE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, etc.).

---

## 4. Finalizing Stripe Webhooks

Once your app is deployed and you have a public URL, you need to tell Stripe where to send payment confirmation events.

1. Go to the Stripe Dashboard > **Developers** > **Webhooks**.
2. Click **Add endpoint**.
3. In the **Endpoint URL** field, enter your deployed app's webhook route:
   `https://your-app-domain.com/api/webhook/stripe`
4. Under **Select events to listen to**, choose `checkout.session.completed`.
5. Click **Add endpoint**.
6. On the next screen, look for the **Signing secret** (it starts with `whsec_`). Click to reveal and copy it.
7. Go back to your hosting provider (Railway/Render) and add a new environment variable:
   - `STRIPE_WEBHOOK_SECRET`: Paste the signing secret here.
8. Redeploy or restart your server to apply the new variable.

---

## 5. Testing the Funnel

1. **Test the Demo Form**: Go to your live URL, enter a phone number, and click "Call Me Now". You should receive a Telegram notification instantly.
2. **Test Checkout**: Click "Get Started Now", fill out the modal, and proceed to Stripe. Use a [Stripe test card](https://stripe.com/docs/testing) (e.g., `4242 4242 4242 4242`) to complete the payment.
3. **Verify Webhook**: After a successful test payment, you should be redirected to the Thank You page, and you should receive a Telegram notification about the new deposit.

Your JARVIS AI funnel is now live and ready to capture leads!
