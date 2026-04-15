/**
 * POST /api/paddle-webhook
 * Přijímá webhooky od Paddle a aktualizuje plán člena v Redis.
 *
 * Relevantní eventy:
 *   subscription.created   → nastavit plan:memberId = pro
 *   subscription.activated → nastavit plan:memberId = pro
 *   subscription.canceled  → smazat plan:memberId (zpět na free)
 *   subscription.past_due  → smazat plan:memberId
 */

import { redis } from '../lib/redis.js';
import { createHmac } from 'crypto';

const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

function verifyPaddleWebhook(req, body) {
  // Paddle Billing webhook verification
  // https://developer.paddle.com/webhooks/signature-verification
  const signature = req.headers['paddle-signature'];
  if (!signature || !PADDLE_WEBHOOK_SECRET) return false;

  const parts = Object.fromEntries(
    signature.split(';').map(p => p.split('='))
  );
  const ts = parts['ts'];
  const h1 = parts['h1'];
  if (!ts || !h1) return false;

  const signed = `${ts}:${body}`;
  const expected = createHmac('sha256', PADDLE_WEBHOOK_SECRET)
    .update(signed)
    .digest('hex');

  return expected === h1;
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Číst raw body pro HMAC verifikaci
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  if (!verifyPaddleWebhook(req, rawBody)) {
    console.warn('Paddle webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = event.event_type;
  const data      = event.data;
  const memberId  = data?.custom_data?.memberId;

  if (!memberId) {
    // Webhook bez memberId — ignorovat (např. manuální Paddle akce)
    console.log(`Paddle webhook ${eventType}: no memberId in custom_data, skipping`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  switch (eventType) {
    case 'subscription.created':
    case 'subscription.activated':
    case 'transaction.completed':
      // Aktivovat Pro plán — bez expirace (obnovuje se automaticky)
      await redis.set(`plan:${memberId}`, 'pro');
      console.log(`Plan activated: ${memberId} → pro`);
      break;

    case 'subscription.canceled':
    case 'subscription.past_due':
      // Vrátit na free
      await redis.del(`plan:${memberId}`);
      console.log(`Plan revoked: ${memberId} → free`);
      break;

    default:
      // Ostatní eventy ignorovat
      console.log(`Paddle webhook: unhandled event ${eventType}`);
  }

  return res.status(200).json({ ok: true });
}
