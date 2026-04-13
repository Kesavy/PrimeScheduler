/**
 * POST /api/schedule
 * Schedules a Trello card comment via QStash.
 * Verifies the caller's OAuth token before accepting the job.
 */

import { redis, KEYS } from '../lib/redis.js';
import { Client }      from '@upstash/qstash';
import { getMember }   from '../lib/trello.js';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

const ALLOWED = process.env.ALLOWED_ORIGIN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  const { memberId, token, cardId, cardName, text, sendAt } = req.body || {};

  if (!memberId || !token || !cardId || !text || !sendAt) {
    return res.status(400).json({ error: 'Missing required fields: memberId, token, cardId, text, sendAt' });
  }

  // Verify the caller's token matches memberId — prevents scheduling under
  // another member's identity even if their token is stored in Redis
  let member;
  try {
    member = await getMember(token);
  } catch {
    return res.status(401).json({ error: 'Invalid Trello token' });
  }
  if (member.id !== memberId) {
    return res.status(403).json({ error: 'Token does not belong to this member' });
  }

  // Check encrypted token exists in Redis (user has completed authorization)
  const storedToken = await redis.get(KEYS.memberToken(memberId));
  if (!storedToken) {
    return res.status(401).json({ error: 'Not authorized. Please connect your Trello account first.', needsAuth: true });
  }

  const sendAtMs  = new Date(sendAt).getTime();
  const delayMs   = sendAtMs - Date.now();
  if (isNaN(delayMs))  return res.status(400).json({ error: 'Invalid sendAt format' });
  if (delayMs < 0)     return res.status(400).json({ error: 'sendAt is in the past' });
  if (delayMs > 7 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Maximum 7 days in advance (QStash free plan limit)' });
  }

  const delaySeconds = Math.ceil(delayMs / 1000);
  const jobId        = crypto.randomUUID();
  const backendUrl   = process.env.BACKEND_URL;

  try {
    const qRes = await qstash.publishJSON({
      url:   `${backendUrl}/api/send-comment`,
      delay: delaySeconds,
      body:  { jobId, memberId, cardId },
    });

    const ttlSecs = delaySeconds + 48 * 3600;
    const pipe = redis.pipeline();
    pipe.set(KEYS.job(jobId), JSON.stringify({
      jobId, memberId, cardId,
      cardName: cardName || cardId,
      text, sendAt,
      createdAt:   new Date().toISOString(),
      qstashMsgId: qRes.messageId,
      status:      'scheduled',
    }), { ex: ttlSecs });
    pipe.sadd(KEYS.memberJobs(memberId), jobId);
    await pipe.exec();

    return res.status(200).json({ ok: true, jobId, scheduledFor: sendAt });
  } catch (err) {
    console.error('schedule error:', err);
    return res.status(500).json({ error: err.message });
  }
}
