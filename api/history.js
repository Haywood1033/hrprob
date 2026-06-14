// api/history.js — Prisma 7 + Neon

let prisma;
async function getPrisma() {
  if (prisma) return prisma;
  const { PrismaClient } = require('./generated/prisma-client');
  const { PrismaNeon } = require('@prisma/adapter-neon');
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
  if (!global._prisma) {
    global._prisma = new PrismaClient({ adapter });
  }
  prisma = global._prisma;
  return prisma;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = await getPrisma();

  try {
    if (req.method === 'GET') {
      const records = await db.dailyPrediction.findMany({
        orderBy: { date: 'desc' },
        take: 30,
      });
      return res.status(200).json({
        records: records.map(r => ({
          date:         r.date,
          predictions:  r.predictions,
          resultsAdded: r.resultsAdded,
          summary:      r.summary,
          savedAt:      r.savedAt,
          fetchedAt:    r.fetchedAt,
        })),
        count: records.length,
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions } = body;

      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        const existing = await db.dailyPrediction.findUnique({ where: { date } });
        if (existing?.resultsAdded) {
          return res.status(200).json({ ok: true, date, skipped: true });
        }

        await db.dailyPrediction.upsert({
          where:  { date },
          update: { predictions: predictions.map(p => ({ ...p, hit: null })), savedAt: new Date() },
          create: { date, predictions: predictions.map(p => ({ ...p, hit: null })) },
        });

        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const record = await db.dailyPrediction.findUnique({ where: { date } });
        if (!record) return res.status(404).json({ error: 'No predictions for ' + date });
        if (record.resultsAdded) return res.status(200).json({ ok: true, record, alreadyAdded: true });

        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error' });

        const mlbData = await mlbR.json();
        const games = mlbData.dates?.[0]?.games || [];

        const hrPlayers = new Set();
        await Promise.allSettled(games.map(async game => {
          try {
            const gr = await fetch(
              `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } }
            );
            if (!gr.ok) return;
            const gd = await gr.json();
            for (const side of ['away', 'home']) {
              const players = Object.values(gd.teams?.[side]?.players || {});
              for (const p of players) {
                if ((p.stats?.batting?.homeRuns || 0) > 0) {
                  hrPlayers.add(p.person?.fullName);
                }
              }
            }
          } catch(e) {}
        }));

        const updated = record.predictions.map(p => ({ ...p, hit: hrPlayers.has(p.name) ? 1 : 0 }));
        const hits = updated.filter(p => p.hit === 1).length;
        const total = updated.length;
        const summary = `${hits}/${total} HR · ${((hits/total)*100).toFixed(1)}% hit rate`;

        await db.dailyPrediction.update({
          where: { date },
          data: { predictions: updated, resultsAdded: true, summary, fetchedAt: new Date() },
        });

        return res.status(200).json({ ok: true, date, summary, hits, total });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('History error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
