// api/history.js — stores and retrieves daily prediction results
// Uses Vercel KV for persistence across devices and sessions

// Vercel KV is available via @vercel/kv when KV_REST_API_URL env var is set
// Falls back to in-memory store for local dev

let memStore = {}; // fallback if KV not configured

async function getKV() {
  try {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const { kv } = await import('@vercel/kv');
      return kv;
    }
  } catch(e) {}
  return null;
}

async function kvGet(key) {
  const kv = await getKV();
  if (kv) return kv.get(key);
  return memStore[key] || null;
}

async function kvSet(key, value) {
  const kv = await getKV();
  if (kv) return kv.set(key, value);
  memStore[key] = value;
}

async function kvKeys(pattern) {
  const kv = await getKV();
  if (kv) return kv.keys(pattern);
  return Object.keys(memStore).filter(k => k.startsWith(pattern.replace('*','')));
}

// Fetch yesterday's HR results from MLB Stats API
async function fetchHRResults(dateStr) {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${dateStr}&endDate=${dateStr}&hydrate=boxscore`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return {};

    const d = await r.json();
    const games = d.dates?.[0]?.games || [];
    const results = {}; // playerName -> {hr: count}

    for (const game of games) {
      const gamePk = game.gamePk;
      // Fetch boxscore for each game
      try {
        const br = await fetch(
          `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!br.ok) continue;
        const box = await br.json();

        for (const side of ['away', 'home']) {
          const players = box.teams?.[side]?.players || {};
          for (const p of Object.values(players)) {
            const name = p.person?.fullName;
            const hr   = p.stats?.batting?.homeRuns || 0;
            if (name) {
              results[name] = { hr, hit: hr > 0 };
            }
          }
        }
      } catch(e) {
        console.warn(`Boxscore ${gamePk}:`, e.message);
      }
    }

    console.log(`HR results for ${dateStr}: ${Object.keys(results).length} players, ${Object.values(results).filter(r=>r.hit).length} HRs`);
    return results;
  } catch(e) {
    console.warn('fetchHRResults error:', e.message);
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // GET /api/history — return all stored records
  if (req.method === 'GET') {
    try {
      const keys = await kvKeys('hrprob:day:*');
      const records = await Promise.all(
        keys.map(async k => {
          const val = await kvGet(k);
          return val;
        })
      );
      const sorted = records
        .filter(Boolean)
        .sort((a, b) => a.date < b.date ? -1 : 1);
      return res.status(200).json({ records: sorted, count: sorted.length });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /api/history — save today's predictions OR fetch+store yesterday's results
  if (req.method === 'POST') {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch(e) {}

    const action = body.action || 'save';

    // action: 'save' — store today's predictions
    if (action === 'save') {
      const { date, predictions } = body;
      if (!date || !predictions?.length) {
        return res.status(400).json({ error: 'date and predictions required' });
      }
      // Don't overwrite if results already recorded
      const existing = await kvGet(`hrprob:day:${date}`);
      if (existing?.resultsAdded) {
        return res.status(200).json({ ok: true, message: 'Results already recorded', existing });
      }
      const record = {
        date,
        predictions: predictions.map(p => ({
          name:     p.name,
          team:     p.team,
          hrp:      p.hrp,
          tier:     p.tier,
          bookOdds: p.bookOdds || null,
          hit:      null, // filled by 'results' action
        })),
        savedAt:      new Date().toISOString(),
        resultsAdded: false,
      };
      await kvSet(`hrprob:day:${date}`, record);
      return res.status(200).json({ ok: true, date, count: predictions.length });
    }

    // action: 'results' — fetch yesterday's results and update stored predictions
    if (action === 'results') {
      const { date } = body;
      if (!date) return res.status(400).json({ error: 'date required' });

      const existing = await kvGet(`hrprob:day:${date}`);
      if (!existing) {
        return res.status(404).json({ error: `No predictions stored for ${date}` });
      }
      if (existing.resultsAdded) {
        return res.status(200).json({ ok: true, message: 'Already done', record: existing });
      }

      // Fetch actual HR results from MLB Stats API
      const hrResults = await fetchHRResults(date);

      // Match predictions to results
      let hits = 0, misses = 0, notFound = 0;
      existing.predictions = existing.predictions.map(p => {
        const result = hrResults[p.name];
        if (result !== undefined) {
          if (result.hit) hits++;
          else misses++;
          return { ...p, hit: result.hit, hr: result.hr };
        }
        // Try fuzzy match (accented chars etc)
        const fuzzy = Object.entries(hrResults).find(([n]) =>
          n.toLowerCase().replace(/[^a-z]/g,'') === p.name.toLowerCase().replace(/[^a-z]/g,'')
        );
        if (fuzzy) {
          if (fuzzy[1].hit) hits++;
          else misses++;
          return { ...p, hit: fuzzy[1].hit, hr: fuzzy[1].hr };
        }
        notFound++;
        return { ...p, hit: false, hr: 0 }; // assume no HR if not found
      });

      existing.resultsAdded = true;
      existing.resultsFetchedAt = new Date().toISOString();
      existing.summary = { hits, misses, notFound };

      await kvSet(`hrprob:day:${date}`, existing);
      console.log(`Results for ${date}: ${hits} HR, ${misses} no HR, ${notFound} not found`);
      return res.status(200).json({ ok: true, record: existing });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
