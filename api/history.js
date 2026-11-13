// api/history.js — uses pg (node-postgres) directly
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// Names differ between sources in accents, punctuation and suffixes
// ("Ronald Acuña Jr." vs "Ronald Acuna Jr"), so compare a normalised form.
function normName(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[.'`’]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// A game only counts toward grading once it is final. Postponed and
// cancelled games are settled (nobody batted); anything else is pending.
function gameState(g) {
  const s = g.status || {};
  if (s.codedGameState === 'F' || s.codedGameState === 'O' || s.abstractGameState === 'Final') {
    return /postponed|cancel/i.test(s.detailedState || '') ? 'off' : 'final';
  }
  if (/postponed|cancel|suspended/i.test(s.detailedState || '')) return 'off';
  return 'pending';
}

// played: normName -> { hr, pa } for everyone who came to the plate.
// A prediction is a hit or a miss only if the player batted; otherwise it
// is void (hit: null, dnp: true) and stays out of every hit rate.
function gradeRow(p, played) {
  const line = played.get(normName(p.name));
  if (!line) return { ...p, hit: null, dnp: true };
  const { dnp, ...rest } = p;
  return { ...rest, hit: line.hr > 0 ? 1 : 0, pa: line.pa };
}

const GRADE_VERSION = 2;

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // This serves the signal lock (mutable, must reflect the latest DB write
  // for every device) and prediction history -- never cache it anywhere.
  res.setHeader('Cache-Control', 'no-store');
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
    await query(`ALTER TABLE daily_predictions ADD COLUMN IF NOT EXISTS grade_v INT DEFAULT 1`);
    // Full-slate model inputs, one row per date. Kept out of
    // daily_predictions so the history GET stays small.
    await query(`
      CREATE TABLE IF NOT EXISTS prediction_features (
        date      VARCHAR(10) PRIMARY KEY,
        rows      JSONB,
        graded    BOOLEAN DEFAULT FALSE,
        saved_at  TIMESTAMP DEFAULT NOW()
      )
    `);

    if (req.method === 'GET') {
      // ?features=YYYY-MM-DD -> that date's full feature log;
      // ?features=index -> which dates have one.
      const fq = req.query?.features;
      if (fq === 'index') {
        const { rows } = await query(`SELECT date, graded, jsonb_array_length(rows) AS n FROM prediction_features ORDER BY date DESC`);
        return res.status(200).json({ dates: rows });
      }
      if (fq) {
        const { rows } = await query(`SELECT date, rows, graded FROM prediction_features WHERE date=$1`, [fq]);
        if (!rows[0]) return res.status(404).json({ error: 'No feature log for ' + fq });
        return res.status(200).json(rows[0]);
      }
      const { rows } = await query(`SELECT * FROM daily_predictions ORDER BY date DESC LIMIT 200`);
      return res.status(200).json({
        records: rows.map(r => ({
          date: r.date, predictions: r.predictions,
          signalLock: r.signal_lock,
          gameLeans: r.game_leans,
          resultsAdded: r.results_added, gradeV: r.grade_v || 1, summary: r.summary,
          savedAt: r.saved_at, fetchedAt: r.fetched_at,
        })),
        count: rows.length,
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions, signalLock, gameLeans, features, force } = body;

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

        // First write wins, same as predictions: the log is a pre-game snapshot.
        if (Array.isArray(features) && features.length) {
          await query(`INSERT INTO prediction_features (date, rows) VALUES ($1, $2::jsonb) ON CONFLICT (date) DO NOTHING`,
            [date, JSON.stringify(features)]);
        }

        const existing = await query(`SELECT results_added, saved_at, predictions FROM daily_predictions WHERE date=$1`, [date]);
        if (existing.rows[0]) {
          // Only skip if predictions were actually saved (not just signal lock)
          const existingPreds = existing.rows[0].predictions;
          const hasPreds = existingPreds && Array.isArray(existingPreds) && existingPreds.length > 0;
          if (hasPreds) {
            return res.status(200).json({ ok: true, date, skipped: true, reason: 'Already saved for ' + date });
          }
        }

        const preds    = JSON.stringify(predictions.map(p => ({ ...p, hit: null })));
        const lockData = signalLock ? JSON.stringify(signalLock) : null;
        const leansData = gameLeans ? JSON.stringify(gameLeans) : null;

        await query(`
          INSERT INTO daily_predictions (date, predictions, signal_lock, game_leans)
          VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
          ON CONFLICT (date) DO UPDATE SET
            predictions = EXCLUDED.predictions,
            game_leans  = COALESCE(EXCLUDED.game_leans, daily_predictions.game_leans),
            saved_at    = NOW()
          WHERE daily_predictions.predictions IS NULL 
             OR jsonb_array_length(daily_predictions.predictions) = 0
        `, [date, preds, lockData, leansData]);

        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const { rows } = await query(`SELECT * FROM daily_predictions WHERE date=$1`, [date]);
        const record = rows[0];
        if (!record) return res.status(404).json({ error: 'No predictions for ' + date });
        if (record.results_added && !force) return res.status(200).json({ ok: true, record: {
          ...record,
          predictions: record.predictions,
          gameLeans: record.game_leans,
          resultsAdded: record.results_added,
          summary: record.summary,
        }, alreadyAdded: true });

        // Fetch MLB schedule with linescore for this date
        // gameType=R,F,D,L,W: regular season + all postseason rounds --
        // omitting gameType can silently default to regular-season-only,
        // which would make yesterday's postseason results invisible here.
        const mlbR = await fetch(
          `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&gameType=R,F,D,L,W&hydrate=linescore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!mlbR.ok) return res.status(502).json({ error: 'MLB API error' });

        const allGames = (await mlbR.json()).dates?.[0]?.games || [];
        const games = allGames.filter(g => gameState(g) === 'final');
        const pending = allGames.filter(g => gameState(g) === 'pending').length;
        const played = new Map();   // normName -> { hr, pa }
        let failed = 0;
        const gameResults = {}; // gamePk → { winner, awayScore, homeScore, awayF5, homeF5, firstInningRuns }

        await Promise.allSettled(games.map(async g => {
          try {
            // Get box score for HR data
            const gr = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`,
              { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!gr.ok) { failed++; return; }
            const gd = await gr.json();

            // Everyone who came to the plate, with their HR count. Summed
            // across games so a doubleheader counts as one day.
            for (const side of ['away','home'])
              for (const p of Object.values(gd.teams?.[side]?.players||{})) {
                const bat = p.stats?.batting || {};
                const pa = bat.plateAppearances || 0;
                if (pa < 1) continue;
                const key = normName(p.person?.fullName);
                const cur = played.get(key) || { hr: 0, pa: 0 };
                played.set(key, { hr: cur.hr + (bat.homeRuns||0), pa: cur.pa + pa });
              }

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
          } catch(e) { failed++; }
        }));

        // A missing box score used to grade that whole game as misses and
        // lock the date for good. Now the date stays open and the client
        // retries -- unless it is over three days old, when whatever MLB
        // has is taken as final so a dead game cannot block grading forever.
        const ageDays = (Date.now() - new Date(date + 'T12:00:00Z').getTime()) / 864e5;
        if ((failed > 0 || pending > 0) && ageDays < 3) {
          return res.status(200).json({ ok: false, retry: true, date,
            reason: `${failed} box score(s) failed, ${pending} game(s) not final` });
        }

        // Update HR predictions
        const existing_preds = record.predictions || [];
        const updated = existing_preds.map(p => gradeRow(p, played));

        // Grade the full-slate feature log the same way.
        const feat = await query(`SELECT rows FROM prediction_features WHERE date=$1`, [date]);
        if (feat.rows[0]?.rows) {
          await query(`UPDATE prediction_features SET rows=$2::jsonb, graded=TRUE WHERE date=$1`,
            [date, JSON.stringify(feat.rows[0].rows.map(p => gradeRow(p, played)))]);
        }

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
        const graded = updated.filter(p => p.hit !== null).length;
        const voided = updated.length - graded;
        const summary = updated.length > 0
          ? `${hits}/${graded} HR · ${graded ? ((hits/graded)*100).toFixed(1) : '0.0'}% hit rate${voided ? ` · ${voided} did not bat` : ''}`
          : `No predictions saved for ${date}`;

        await query(`
          UPDATE daily_predictions
          SET predictions=$2::jsonb, game_leans=$3::jsonb, results_added=TRUE, summary=$4, fetched_at=NOW(), grade_v=$5
          WHERE date=$1
        `, [date, JSON.stringify(updated), JSON.stringify(updatedLeans), summary, GRADE_VERSION]);

        return res.status(200).json({ ok: true, date, summary, hits, total: graded, voided,
          leanResults: updatedLeans.filter(l=>l.fgMLResult!==null||l.nrfiResult!==null).length });
      }
    }
  } catch(e) {
    console.error('History API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
}

module.exports = handler;
module.exports.normName = normName;
module.exports.gameState = gameState;
module.exports.gradeRow = gradeRow;
