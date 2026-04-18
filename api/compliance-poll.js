/**
 * GET /api/compliance-poll
 * Polls Trello's compliance API for Right to be Forgotten requests.
 * Must be called at least every 14 days.
 * 
 * Called automatically by Vercel cron (vercel.json) every 7 days.
 * Can also be called manually: /api/compliance-poll?token=COMPLIANCE_POLL_TOKEN
 */

import { redis } from '../lib/redis.js';

const PLUGIN_ID      = '69dcebc21ad249b909ac8827';
const OAUTH_SECRET   = process.env.TRELLO_OAUTH_SECRET;
const COMPLIANCE_TOKEN = process.env.COMPLIANCE_POLL_TOKEN;

export default async function handler(req, res) {
  const isCron   = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = req.query.token && req.query.token === COMPLIANCE_TOKEN;

  if (!isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).end();

  try {
    // Correct endpoint: /1/plugins/{idPlugin}/compliance/memberPrivacy?secret=OAUTH_SECRET
    const url = `https://api.trello.com/1/plugins/${PLUGIN_ID}/compliance/memberPrivacy?secret=${OAUTH_SECRET}`;
    const pollRes = await fetch(url, { headers: { 'Accept': 'application/json' } });

    if (!pollRes.ok) {
      const err = await pollRes.text();
      console.error('Trello compliance API error:', err);
      return res.status(500).json({ error: 'Trello API error', details: err });
    }

    // Response is an array of events: { id, date, event, alteredFields? }
    const events = await pollRes.json();
    console.log(`Compliance poll: ${events.length} events`);

    let deleted = 0;
    for (const event of events) {
      const memberId = event.id;

      if (event.event === 'accountDeleted' || event.event === 'tokenRevoked' || event.event === 'tokenExpired') {
        // Delete all stored data for this member
        const pipe = redis.pipeline();
        pipe.del(`token:${memberId}`);
        pipe.del(`plan:${memberId}`);

        const jobIds = await redis.smembers(`member:${memberId}:jobs`).catch(() => []);
        for (const jobId of (jobIds || [])) {
          pipe.del(`scheduled:${jobId}`);
        }
        pipe.del(`member:${memberId}:jobs`);
        await pipe.exec();
        deleted++;
        console.log(`Deleted data for member: ${memberId} (${event.event})`);
      }

      if (event.event === 'accountUpdated') {
        // We don't store profile data (name/email/avatar) so nothing to update
        console.log(`Account updated for member: ${memberId} — no action needed`);
      }
    }

    return res.status(200).json({
      ok: true,
      events: events.length,
      deleted,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Compliance poll error:', err);
    return res.status(500).json({ error: err.message });
  }
}
