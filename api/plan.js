/**
 * GET /api/plan?memberId=xxx
 * Vrátí aktuální plán člena (free / pro)
 */

import { redis } from '../lib/redis.js';

const ALLOWED = process.env.ALLOWED_ORIGIN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { memberId } = req.query;
  if (!memberId) return res.status(400).json({ error: 'Missing memberId' });

  const plan = await redis.get(`plan:${memberId}`);
  return res.status(200).json({ plan: plan || 'free' });
}
