// api/history.js — uses pg (node-postgres) directly
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Create table if not exists
    await query(`
      CREATE TABLE IF NOT EXISTS daily_predictions (
        id            SERIAL PRIMARY KEY,
        date          VARCHAR(10) UNIQUE NOT NULL,
        predictions   JSONB,
        results_added BOOLEAN DEFAULT FALSE,
        summary       TEXT,
        saved_at      TIMESTAMP DEFAULT NOW(),
        fetched_at    TIMESTAMP
      )
    `);

    if (req.method === 'GET') {
      const { rows } = await query(`SELECT * FROM daily_predictions ORDER BY date DESC LIMIT 30`);
      return res.status(200).json({
        records: rows.map(r => ({
          date: r.date, predictions: r.predictions,
          resultsAdded: r.results_added, summary: r.summary,
          savedAt: r.saved_at, fetchedAt: r.fetched_at,
        })),
        count: rows.length,
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions } = body;

      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        const { rows: ex } = await query(`SELECT results_added FROM daily_predictions WHERE date=$1`, [date]);
        if (ex[0]?.results_added) return res.status(200).json({ ok: true, date, skipped: true });

        const preds = JSON.stringify(predictions.map(p => ({ ...p, hit: null })));
        await query(`
          INSERT INTO daily_predictions (date, predictions)
          VALUES ($1, $2::jsonb)
          ON CONFLICT (date) DO UPDATE SET predictions=$2::jsonb, saved_at=NOW()
        `, [date, preds]);

        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const { rows } = await query(`SELECT * FROM daily_predictions WHERE date=$1`, [date]);
        const record = rows[0];
        if (!record) return res.status(404).json({ error: 'No predictions for ' + date });
        if (record.results_added) return res.status(200).json({ ok: true, record, alreadyAdded: true });

        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error' });

        const games = (await mlbR.json()).dates?.[0]?.games || [];
        const hrPlayers = new Set();

        await Promise.allSettled(games.map(async g => {
          try {
            const gr = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!gr.ok) return;
            const gd = await gr.json();
            for (const side of ['away','home'])
              for (const p of Object.values(gd.teams?.[side]?.players||{}))
                if ((p.stats?.batting?.homeRuns||0) > 0) hrPlayers.add(p.person?.fullName);
          } catch(e) {}
        }));

        const updated = record.predictions.map(p => ({ ...p, hit: hrPlayers.has(p.name) ? 1 : 0 }));
        const hits = updated.filter(p => p.hit === 1).length;
        const summary = `${hits}/${updated.length} HR · ${((hits/updated.length)*100).toFixed(1)}% hit rate`;

        await query(`
          UPDATE daily_predictions
          SET predictions=$2::jsonb, results_added=TRUE, summary=$3, fetched_at=NOW()
          WHERE date=$1
        `, [date, JSON.stringify(updated), summary]);

        return res.status(200).json({ ok: true, date, summary, hits, total: updated.length });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error('History error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
