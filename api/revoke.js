/**
 * POST /api/revoke
 * Odvolá token, zruší čekající QStash joby (skutečně přes API i v Redis)
 */

import { Client }      from '@upstash/qstash';
import { redis, KEYS } from '../lib/redis.js';
import { getMember }   from '../lib/trello.js';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  const allowed = process.env.ALLOWED_ORIGIN || 'https://praceburian-debug.github.io';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method Not Allowed' });

  const { memberId, token } = req.body || {};
  if (!memberId || !token) return res.status(400).json({ error: 'Chybí memberId nebo token' });

  try {
    const member = await getMember(token);
    if (member.id !== memberId) return res.status(403).json({ error: 'Neoprávněný přístup' });
  } catch {
    return res.status(401).json({ error: 'Neplatný token' });
  }

  const jobIds = await redis.smembers(KEYS.memberJobs(memberId));
  let cancelledCount = 0;

  // Zpracuj joby paralelně po dávkách aby se nepřekročil timeout Vercel funkce
  const BATCH = 10;
  for (let i = 0; i < jobIds.length; i += BATCH) {
    const batch = jobIds.slice(i, i + BATCH);
    await Promise.all(batch.map(async (jobId) => {
      const jobRaw = await redis.get(KEYS.job(jobId));
      if (!jobRaw) return;
      const job = typeof jobRaw === 'string' ? JSON.parse(jobRaw) : jobRaw;
      if (job.status !== 'scheduled') return;

      // Skutečné zrušení v QStash — zabrání odeslání komentáře
      if (job.qstashMsgId) {
        try {
          await qstash.messages.delete(job.qstashMsgId);
        } catch (e) {
          // QStash vrátí 404 pokud zpráva už byla doručena nebo neexistuje — ignorujeme
          if (!e.message?.includes('404')) {
            console.warn(`QStash cancel ${job.qstashMsgId}:`, e.message);
          }
        }
      }

      // Aktualizuj stav v Redis
      await redis.set(
        KEYS.job(jobId),
        JSON.stringify({ ...job, status: 'cancelled', cancelledAt: new Date().toISOString() }),
        { ex: 48 * 3600 }
      );
      cancelledCount++;
    }));
  }

  // Smaž token, seznam jobů a všechny auth-cache záznamy tohoto člena
  // auth-cache klíče jsou auth-cache:{memberId}:{tokenHash} — smažeme přes scan s prefixem
  const authCacheKeys = await redis.keys(`auth-cache:${memberId}:*`);

  const pipe = redis.pipeline();
  pipe.del(KEYS.memberToken(memberId));
  pipe.del(KEYS.memberJobs(memberId));
  // keys() vrátí max desítky klíčů (jeden per aktivní token hash) — scan je zde bezpečný
  authCacheKeys.forEach(k => pipe.del(k));
  await pipe.exec();

  return res.status(200).json({ ok: true, cancelledJobs: cancelledCount });
}
