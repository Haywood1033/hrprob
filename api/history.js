// api/history.js — accuracy tracking via Vercel KV
const { kv } = require('@vercel/kv');

const KEY_PREFIX = 'hrprob:history:';
const INDEX_KEY  = 'hrprob:history:index';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');

  try {
    // ── GET: return all records ──────────────────────────────
    if (req.method === 'GET') {
      const dates = await kv.smembers(INDEX_KEY) || [];
      if (!dates.length) return res.status(200).json({ records: [], count: 0 });

      const records = await Promise.all(
        dates.sort().map(date => kv.get(KEY_PREFIX + date))
      );
      const valid = records.filter(Boolean).sort((a,b) => a.date > b.date ? 1 : -1);
      return res.status(200).json({ records: valid, count: valid.length });
    }

    // ── POST ─────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, date, predictions } = body;

      // ── SAVE today's predictions ──────────────────────────
      if (action === 'save') {
        if (!date || !predictions?.length)
          return res.status(400).json({ error: 'Missing date or predictions' });

        // Check if already saved today to avoid overwriting
        const existing = await kv.get(KEY_PREFIX + date);
        if (existing?.resultsAdded) {
          return res.status(200).json({ ok: true, date, count: existing.predictions.length, skipped: true });
        }

        const record = {
          date,
          predictions: predictions.map(p => ({ ...p, hit: null })),
          resultsAdded: false,
          savedAt: new Date().toISOString(),
        };

        await kv.set(KEY_PREFIX + date, record);
        await kv.sadd(INDEX_KEY, date);

        console.log(`Saved ${predictions.length} predictions for ${date}`);
        return res.status(200).json({ ok: true, date, count: predictions.length });
      }

      // ── FETCH yesterday's results ─────────────────────────
      if (action === 'results') {
        if (!date) return res.status(400).json({ error: 'Missing date' });

        const record = await kv.get(KEY_PREFIX + date);
        if (!record) return res.status(404).json({ error: 'No record for ' + date });
        if (record.resultsAdded) return res.status(200).json({ ok: true, record, alreadyAdded: true });

        // Fetch MLB box scores for that date
        const mlbUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore,boxscore`;
        const r = await fetch(mlbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return res.status(502).json({ error: 'MLB API error' });

        const data = await r.json();
        const games = data.dates?.[0]?.games || [];

        // Build set of players who hit HRs
        const hrPlayers = new Set();
        for (const game of games) {
          const boxUrl = `https://statsapi.mlb.com/api/v1/game/${game.gamePk}/boxscore`;
          try {
            const br = await fetch(boxUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!br.ok) continue;
            const box = await br.json();
            for (const side of ['away', 'home']) {
              const batters = box.teams?.[side]?.batters || [];
              const players = box.teams?.[side]?.players || {};
              for (const id of batters) {
                const p = players['ID' + id];
                const hr = p?.stats?.batting?.homeRuns || 0;
                if (hr > 0) {
                  const name = p?.person?.fullName;
                  if (name) hrPlayers.add(name);
                }
              }
            }
          } catch(e) { continue; }
        }

        // Mark each prediction
        let hits = 0, tracked = 0;
        const updated = record.predictions.map(p => {
          // Try exact match and last-name match
          const hit = hrPlayers.has(p.name) ||
            [...hrPlayers].some(n => n.toLowerCase().includes(p.name.split(' ').pop().toLowerCase()) &&
              p.name.toLowerCase().includes(n.split(' ')[0]?.toLowerCase()));
          if (hit) hits++;
          tracked++;
          return { ...p, hit };
        });

        const updatedRecord = {
          ...record,
          predictions: updated,
          resultsAdded: true,
          summary: `${hits}/${tracked} HR`,
          fetchedAt: new Date().toISOString(),
        };

        await kv.set(KEY_PREFIX + date, updatedRecord);
        console.log(`Results for ${date}: ${hits}/${tracked} HR`);
        return res.status(200).json({ ok: true, record: updatedRecord, summary: `${hits}/${tracked}` });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error('History error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
