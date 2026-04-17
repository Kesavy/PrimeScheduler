/**
 * GET /api/compliance-poll
 * Polls Trello's compliance API for Right to be Forgotten requests.
 * Must be called at least every 14 days.
 * 
 * Called automatically by Vercel cron (vercel.json) every 7 days.
 * Can also be called manually by visiting the URL with the correct token.
 */

import { redis } from '../lib/redis.js';

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const COMPLIANCE_TOKEN = process.env.COMPLIANCE_POLL_TOKEN; // secret token to protect manual calls

export default async function handler(req, res) {
  // Allow Vercel cron (Authorization header) or manual call with token
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;

  const isCron   = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual = queryToken && queryToken === COMPLIANCE_TOKEN;

  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET') return res.status(405).end();

  try {
    // 1. Fetch members who requested Right to be Forgotten
    const rtbfRes = await fetch(
      `https://api.trello.com/1/app-plugins/${TRELLO_API_KEY}/compliance/memberPrivacy?key=${TRELLO_API_KEY}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!rtbfRes.ok) {
      const err = await rtbfRes.text();
      console.error('Trello compliance API error:', err);
      return res.status(500).json({ error: 'Trello API error', details: err });
    }

    const data = await rtbfRes.json();
    const members = data?.members || [];
    console.log(`Compliance poll: ${members.length} members to process`);

    let deleted = 0;
    for (const { id: memberId } of members) {
      // Delete all stored data for this member
      const pipe = redis.pipeline();
      pipe.del(`token:${memberId}`);
      pipe.del(`plan:${memberId}`);

      // Get and delete all jobs for this member
      const jobIds = await redis.smembers(`member:${memberId}:jobs`);
      for (const jobId of (jobIds || [])) {
        pipe.del(`scheduled:${jobId}`);
      }
      pipe.del(`member:${memberId}:jobs`);
      await pipe.exec();
      deleted++;
      console.log(`Deleted data for member: ${memberId}`);
    }

    // 2. Fetch members who updated their profile (Right to Rectification)
    // We don't store profile data (name/email) so nothing to update — just acknowledge
    const rectRes = await fetch(
      `https://api.trello.com/1/app-plugins/${TRELLO_API_KEY}/compliance/memberPrivacy?key=${TRELLO_API_KEY}&type=rectification`,
      { headers: { 'Accept': 'application/json' } }
    ).catch(() => null);

    return res.status(200).json({
      ok: true,
      processed: members.length,
      deleted,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Compliance poll error:', err);
    return res.status(500).json({ error: err.message });
  }
}
