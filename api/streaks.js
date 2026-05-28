// api/streaks.js — last 14 games stats using game log endpoint
const CACHE_TTL = 30 * 60 * 1000;
let cache = { data: null, timestamp: null };

async function searchPlayer(name) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1&active=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d.people?.[0]?.id || null;
}

async function getGameLog(playerId) {
  // Fetch full season game log — returns one entry per game with PA
  // Use a high limit to ensure we get all games
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&sportId=1&limit=200`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();

  const splits = d.stats?.[0]?.splits || [];
  if (!splits.length) return null;

  // Filter to only games with at least 1 PA and sort by date ascending
  const gameSplits = splits
    .filter(s => (s.stat?.plateAppearances || s.stat?.atBats || 0) > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Take last 14 games with PA
  const last14 = gameSplits.slice(-14);

  let hr=0, h=0, ab=0, tb=0, bb=0;
  for (const s of last14) {
    hr += s.stat?.homeRuns    || 0;
    h  += s.stat?.hits        || 0;
    ab += s.stat?.atBats      || 0;
    tb += s.stat?.totalBases  || 0;
    bb += s.stat?.baseOnBalls || 0;
  }

  const games = last14.length;
  const avg = ab > 0 ? +(h/ab).toFixed(3)  : 0;
  const slg = ab > 0 ? +(tb/ab).toFixed(3) : 0;
  const obp = (ab+bb) > 0 ? +((h+bb)/(ab+bb)).toFixed(3) : 0;

  // Flame tiers based on 14-game HR count
  let flame = '';
  if      (hr >= 4)                  flame = '🔥🔥';
  else if (hr >= 2)                  flame = '🔥';
  else if (ab >= 30 && slg < 0.300)  flame = '❄️';

  console.log(`${playerId}: ${games} games, ${hr} HR, ${ab} AB, total splits: ${splits.length}`);
  return { hr, avg, slg, obp, ab, games, flame };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  let names = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    names = body.names || [];
  } catch(e) { return res.status(400).json({ error: 'Invalid body' }); }

  if (!names.length) return res.status(400).json({ error: 'No names' });

  const results = {};
  const start = Date.now();

  for (let i = 0; i < Math.min(names.length, 40); i += 5) {
    const batch = names.slice(i, i+5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const id = await searchPlayer(name);
        if (!id) return;
        const stats = await getGameLog(id);
        if (stats) results[name] = stats;
      } catch(e) { console.warn(`Streak ${name}:`, e.message); }
    }));
  }

  console.log(`Streaks: ${Object.keys(results).length}/${names.length} in ${Date.now()-start}ms`);
  cache = { data: { streaks: results }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800');
  return res.status(200).json({ streaks: results, elapsed: Date.now()-start });
};
