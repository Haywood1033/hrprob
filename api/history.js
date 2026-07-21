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
        signal_lock   JSONB,
        game_leans    JSONB,
        results_added BOOLEAN DEFAULT FALSE,
        summary       TEXT,
        saved_at      TIMESTAMP DEFAULT NOW(),
        fetched_at    TIMESTAMP
      )
    `);
    await query(`ALTER TABLE daily_predictions ADD COLUMN IF NOT EXISTS signal_lock JSONB`);
    await query(`ALTER TABLE daily_predictions ADD COLUMN IF NOT EXISTS game_leans JSONB`);

    if (req.method === 'GET') {
      const { rows } = await query(`SELECT * FROM daily_predictions ORDER BY date DESC LIMIT 30`);
      return res.status(200).json({
        records: rows.map(r => ({
          date: r.date, predictions: r.predictions,
          signalLock: r.signal_lock,
          gameLeans: r.game_leans,
          resultsAdded: r.results_added, summary: r.summary,
          savedAt: r.saved_at, fetchedAt: r.fetched_at,
        })),
        count: rows.length,
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions, signalLock, gameLeans } = body;

      if (action === 'save_leans') {
        if (!date || !gameLeans?.length) return res.status(400).json({ error: 'Missing date or gameLeans' });
        await query(`UPDATE daily_predictions SET game_leans = $2::jsonb WHERE date = $1`, [date, JSON.stringify(gameLeans)]);
        return res.status(200).json({ ok: true, date, count: gameLeans.length });
      }

      if (action === 'save_lock') {
        if (!date || !signalLock) return res.status(400).json({ error: 'Missing date or signalLock' });
        // Try update first, then insert if no record exists
        const updated = await query(
          `UPDATE daily_predictions SET signal_lock = $2::jsonb WHERE date = $1`,
          [date, JSON.stringify(signalLock)]
        );
        if (updated.rowCount === 0) {
          // No record yet — insert with just the lock
          await query(
            `INSERT INTO daily_predictions (date, signal_lock) VALUES ($1, $2::jsonb) ON CONFLICT (date) DO UPDATE SET signal_lock = $2::jsonb`,
            [date, JSON.stringify(signalLock)]
          );
        }
        return res.status(200).json({ ok: true, date });
      }

      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        const existing = await query(`SELECT results_added, saved_at FROM daily_predictions WHERE date=$1`, [date]);
        if (existing.rows[0]) {
          return res.status(200).json({ ok: true, date, skipped: true, reason: 'Already saved for ' + date });
        }

        const preds    = JSON.stringify(predictions.map(p => ({ ...p, hit: null })));
        const lockData = signalLock ? JSON.stringify(signalLock) : null;
        const leansData = gameLeans ? JSON.stringify(gameLeans) : null;

        await query(`
          INSERT INTO daily_predictions (date, predictions, signal_lock, game_leans)
          VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
          ON CONFLICT (date) DO NOTHING
        `, [date, preds, lockData, leansData]);

        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const { rows } = await query(`SELECT * FROM daily_predictions WHERE date=$1`, [date]);
        const record = rows[0];
        if (!record) return res.status(404).json({ error: 'No predictions for ' + date });
        if (record.results_added) return res.status(200).json({ ok: true, record: {
          ...record,
          predictions: record.predictions,
          gameLeans: record.game_leans,
          resultsAdded: record.results_added,
          summary: record.summary,
        }, alreadyAdded: true });

        // Fetch MLB schedule with linescore for this date
        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error' });

        const games = (await mlbR.json()).dates?.[0]?.games || [];
        const hrPlayers = new Set();
        const gameResults = {}; // gamePk → { winner, awayScore, homeScore, awayF5, homeF5, firstInningRuns }

        await Promise.allSettled(games.map(async g => {
          try {
            // Get box score for HR data
            const gr = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!gr.ok) return;
            const gd = await gr.json();

            // HR players
            for (const side of ['away','home'])
              for (const p of Object.values(gd.teams?.[side]?.players||{}))
                if ((p.stats?.batting?.homeRuns||0) > 0) hrPlayers.add(p.person?.fullName);

            // Game score + winner
            const awayScore = gd.teams?.away?.teamStats?.batting?.runs ?? null;
            const homeScore = gd.teams?.home?.teamStats?.batting?.runs ?? null;
            const winner = awayScore !== null && homeScore !== null
              ? (awayScore > homeScore ? g.teams?.away?.team?.name : g.teams?.home?.team?.name)
              : null;

            // F5 score from linescore innings
            const linescore = g.linescore;
            const innings = linescore?.innings || [];
            let awayF5 = 0, homeF5 = 0, firstInningRuns = 0;
            innings.slice(0,5).forEach(inn => {
              awayF5 += inn.away?.runs || 0;
              homeF5 += inn.home?.runs || 0;
            });
            // First inning
            if (innings[0]) {
              firstInningRuns = (innings[0].away?.runs||0) + (innings[0].home?.runs||0);
            }

            // Map team name to our format
            const awayTeam = g.teams?.away?.team?.name;
            const homeTeam = g.teams?.home?.team?.name;

            gameResults[g.gamePk] = {
              winner, awayScore, homeScore,
              awayF5, homeF5, f5Total: awayF5 + homeF5,
              f5Winner: awayF5 > homeF5 ? awayTeam : homeF5 > awayF5 ? homeTeam : null,
              firstInningRuns,
              nrfi: firstInningRuns === 0,
              awayTeam, homeTeam,
            };
          } catch(e) {}
        }));

        // Update HR predictions
        const updated = record.predictions.map(p => ({ ...p, hit: hrPlayers.has(p.name) ? 1 : 0 }));

        // Update game leans with results
        const updatedLeans = (record.game_leans || []).map(lean => {
          const gr = gameResults[lean.gamePk];
          if (!gr) return lean;

          // Helper to match team names (our names may differ from MLB full names)
          const matchTeam = (ourName, mlbName) => mlbName && (mlbName.includes(ourName) || ourName.includes(mlbName.split(' ').pop()));

          // F5 ML result
          const f5MLResult = lean.f5ML && gr.f5Winner !== null
            ? (matchTeam(lean.f5ML, gr.f5Winner) ? 1 : 0) : null;

          // F5 Total result
          const f5TotalResult = lean.f5TotalLean && gr.f5Total !== undefined
            ? (lean.f5TotalLean === 'over' ? (gr.f5Total > lean.f5Ou ? 1 : 0)
             : lean.f5TotalLean === 'under' ? (gr.f5Total < lean.f5Ou ? 1 : 0) : null)
            : null;

          // Full game ML result
          const fgMLResult = lean.fgML && gr.winner !== null
            ? (matchTeam(lean.fgML, gr.winner) ? 1 : 0) : null;

          // Full game total result
          const fgTotalResult = lean.fgTotalLean && gr.awayScore !== null && lean.ou
            ? (() => {
                const actual = (gr.awayScore||0) + (gr.homeScore||0);
                return lean.fgTotalLean === 'over' ? (actual > lean.ou ? 1 : 0)
                     : lean.fgTotalLean === 'under' ? (actual < lean.ou ? 1 : 0) : null;
              })()
            : null;

          // NRFI result
          const nrfiResult = gr.firstInningRuns !== undefined
            ? (lean.nrfiLean ? (gr.nrfi ? 1 : 0) : lean.yrfiLean ? (!gr.nrfi ? 1 : 0) : null)
            : null;

          return { ...lean, f5MLResult, f5TotalResult, fgMLResult, fgTotalResult, nrfiResult,
                   actualF5Total: gr.f5Total, actualTotal: (gr.awayScore||0)+(gr.homeScore||0),
                   actualWinner: gr.winner, actualF5Winner: gr.f5Winner, firstInningRuns: gr.firstInningRuns };
        });

        const hits = updated.filter(p => p.hit === 1).length;
        const summary = `${hits}/${updated.length} HR · ${((hits/updated.length)*100).toFixed(1)}% hit rate`;

        await query(`
          UPDATE daily_predictions
          SET predictions=$2::jsonb, game_leans=$3::jsonb, results_added=TRUE, summary=$4, fetched_at=NOW()
          WHERE date=$1
        `, [date, JSON.stringify(updated), JSON.stringify(updatedLeans), summary]);

        return res.status(200).json({ ok: true, date, summary, hits, total: updated.length,
          leanResults: updatedLeans.filter(l=>l.fgMLResult!==null||l.nrfiResult!==null).length });
      }
    }
  } catch(e) {
    console.error('History API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
