/**
 * POST /api/revoke-job
 * Cancels a single scheduled job — called when user clicks × on a pending comment.
 */

import { Client }      from '@upstash/qstash';
import { redis, KEYS } from '../lib/redis.js';
import { getMember }   from '../lib/trello.js';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });
const ALLOWED = process.env.ALLOWED_ORIGIN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).end();

  const { jobId, memberId, token } = req.body || {};
  if (!jobId || !memberId || !token) return res.status(400).json({ error: 'Missing fields' });

  // Verify caller
  try {
    const member = await getMember(token);
    if (member.id !== memberId) return res.status(403).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const jobRaw = await redis.get(KEYS.job(jobId));
  if (!jobRaw) return res.status(404).json({ error: 'Job not found' });
  const job = typeof jobRaw === 'string' ? JSON.parse(jobRaw) : jobRaw;

  // Only the job owner can cancel
  if (job.memberId !== memberId) return res.status(403).json({ error: 'Not your job' });

  // Cancel in QStash
  if (job.qstashMsgId) {
    try { await qstash.messages.delete(job.qstashMsgId); }
    catch (e) { if (!e.message?.includes('404')) console.warn('QStash cancel:', e.message); }
  }

  // Mark cancelled in Redis
  await redis.set(
    KEYS.job(jobId),
    JSON.stringify({ ...job, status: 'cancelled', cancelledAt: new Date().toISOString() }),
    { ex: 48 * 3600 }
  );
  await redis.srem(KEYS.memberJobs(memberId), jobId);

  return res.status(200).json({ ok: true });
}
