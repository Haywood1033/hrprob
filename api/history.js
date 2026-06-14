// api/history.js — using @vercel/postgres directly (no Prisma needed)
const { sql } = require('@vercel/postgres');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Ensure table exists
    await sql`
      CREATE TABLE IF NOT EXISTS daily_predictions (
        id           SERIAL PRIMARY KEY,
        date         VARCHAR(10) UNIQUE NOT NULL,
        predictions  JSONB,
        results_added BOOLEAN DEFAULT FALSE,
        summary      TEXT,
        saved_at     TIMESTAMP DEFAULT NOW(),
        fetched_at   TIMESTAMP
      )
    `;

    // ── GET ──────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT * FROM daily_predictions ORDER BY date DESC LIMIT 30
      `;
      return res.status(200).json({
        records: rows.map(r => ({
          date:         r.date,
          predictions:  r.predictions,
          resultsAdded: r.results_added,
          summary:      r.summary,
          savedAt:      r.saved_at,
          fetchedAt:    r.fetched_at,
        })),
        count: rows.length,
      });
    }

    // ── POST ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions } = body;

      // SAVE today's predictions
      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        const { rows: existing } = await sql`
          SELECT results_added FROM daily_predictions WHERE date = ${date}
        `;
        if (existing[0]?.results_added)
          return res.status(200).json({ ok: true, date, skipped: true });

        const preds = JSON.stringify(predictions.map(p => ({ ...p, hit: null })));
        await sql`
          INSERT INTO daily_predictions (date, predictions)
          VALUES (${date}, ${preds}::jsonb)
          ON CONFLICT (date) DO UPDATE
          SET predictions = ${preds}::jsonb, saved_at = NOW()
        `;
        console.log(`Saved ${predictions.length} predictions for ${date}`);
        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      // FETCH results for a date
      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const { rows } = await sql`
          SELECT * FROM daily_predictions WHERE date = ${date}
        `;
        const record = rows[0];
        if (!record) return res.status(404).json({ error: 'No predictions for ' + date });
        if (record.results_added) return res.status(200).json({ ok: true, record, alreadyAdded: true });

        // Fetch MLB box scores
        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error' });

        const games = (await mlbR.json()).dates?.[0]?.games || [];
        const hrPlayers = new Set();

        await Promise.allSettled(games.map(async g => {
          try {
            const gr = await fetch(
              `https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } }
            );
            if (!gr.ok) return;
            const gd = await gr.json();
            for (const side of ['away','home']) {
              for (const p of Object.values(gd.teams?.[side]?.players||{})) {
                if ((p.stats?.batting?.homeRuns||0) > 0) hrPlayers.add(p.person?.fullName);
              }
            }
          } catch(e) {}
        }));

        const updated = record.predictions.map(p => ({
          ...p, hit: hrPlayers.has(p.name) ? 1 : 0
        }));
        const hits    = updated.filter(p => p.hit === 1).length;
        const total   = updated.length;
        const summary = `${hits}/${total} HR · ${((hits/total)*100).toFixed(1)}% hit rate`;

        await sql`
          UPDATE daily_predictions
          SET predictions = ${JSON.stringify(updated)}::jsonb,
              results_added = TRUE,
              summary = ${summary},
              fetched_at = NOW()
          WHERE date = ${date}
        `;

        return res.status(200).json({ ok: true, date, summary, hits, total });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error('History error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
