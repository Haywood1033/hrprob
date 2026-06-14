// api/history.js — accuracy tracking via Prisma + Neon Postgres

let prisma;
async function getPrisma() {
  if (!prisma) {
    const { PrismaClient } = require('../generated/prisma-client');
    if (!global._prisma) global._prisma = new PrismaClient();
    prisma = global._prisma;
  }
  return prisma;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const db = await getPrisma();

  try {
    // ── GET: return all records ──────────────────────────────
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

      // ── SAVE today's predictions ──────────────────────────
      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        const existing = await db.dailyPrediction.findUnique({ where: { date } });
        if (existing?.resultsAdded) {
          return res.status(200).json({ ok: true, date, skipped: true, reason: 'Results already added' });
        }

        await db.dailyPrediction.upsert({
          where:  { date },
          update: { predictions: predictions.map(p => ({ ...p, hit: null })), savedAt: new Date() },
          create: { date, predictions: predictions.map(p => ({ ...p, hit: null })) },
        });

        console.log(`Saved ${predictions.length} predictions for ${date}`);
        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      // ── FETCH results for a date ──────────────────────────
      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const record = await db.dailyPrediction.findUnique({ where: { date } });
        if (!record) return res.status(404).json({ error: 'No predictions saved for ' + date });
        if (record.resultsAdded) return res.status(200).json({ ok: true, record, alreadyAdded: true });

        // Fetch MLB box scores for that date
        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error: ' + mlbR.status });

        const mlbData = await mlbR.json();
        const games = mlbData.dates?.[0]?.games || [];

        // Collect all players who hit HRs from box scores
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
          } catch(e) { /* skip failed game */ }
        }));

        console.log(`HR players on ${date}:`, [...hrPlayers].join(', '));

        // Update predictions with results
        const preds = record.predictions;
        const updated = preds.map(p => ({ ...p, hit: hrPlayers.has(p.name) ? 1 : 0 }));

        // Calculate summary stats
        const total   = updated.length;
        const hits    = updated.filter(p => p.hit === 1).length;
        // Calibration by tier
        const tiers = {};
        for (const p of updated) {
          const tier = p.hrp >= 15 ? 'high' : p.hrp >= 10 ? 'mid' : p.hrp >= 7 ? 'low' : 'fringe';
          if (!tiers[tier]) tiers[tier] = { n: 0, hits: 0, avgProb: 0 };
          tiers[tier].n++;
          tiers[tier].hits += p.hit;
          tiers[tier].avgProb += p.hrp;
        }
        for (const t of Object.values(tiers)) t.avgProb = +(t.avgProb / t.n).toFixed(1);

        const summary = `${hits}/${total} HR · ${((hits/total)*100).toFixed(1)}% hit rate`;

        await db.dailyPrediction.update({
          where: { date },
          data: {
            predictions:  updated,
            resultsAdded: true,
            summary,
            fetchedAt:    new Date(),
          },
        });

        console.log(`Results added for ${date}: ${summary}`);
        return res.status(200).json({ ok: true, date, summary, hits, total, tiers });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('History error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
