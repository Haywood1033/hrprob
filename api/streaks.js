// api/streaks.js — HR streak based on last 20 plate appearances
const CACHE_TTL = 2 * 3600 * 1000; // 2 hours — game logs don't change frequently
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

async function getLast20PA(playerId) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&sportId=1&limit=200`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();

  const splits = d.stats?.[0]?.splits || [];
  if (!splits.length) return null;

  // Sort by date descending — most recent first
  const sorted = splits
    .filter(s => (s.stat?.plateAppearances || 0) > 0)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  // Walk back through games until we accumulate 20 PA
  let hr=0, h=0, ab=0, tb=0, bb=0, pa=0, games=0;
  for (const s of sorted) {
    const gamePa = s.stat?.plateAppearances || 0;
    if (pa + gamePa > 20) {
      // Take partial game to hit exactly 20 PA — use proportional stats
      const fraction = (20 - pa) / gamePa;
      hr += Math.round((s.stat?.homeRuns    || 0) * fraction);
      h  += Math.round((s.stat?.hits        || 0) * fraction);
      ab += Math.round((s.stat?.atBats      || 0) * fraction);
      tb += Math.round((s.stat?.totalBases  || 0) * fraction);
      bb += Math.round((s.stat?.baseOnBalls || 0) * fraction);
      pa = 20;
      games++;
      break;
    }
    hr += s.stat?.homeRuns    || 0;
    h  += s.stat?.hits        || 0;
    ab += s.stat?.atBats      || 0;
    tb += s.stat?.totalBases  || 0;
    bb += s.stat?.baseOnBalls || 0;
    pa += gamePa;
    games++;
    if (pa >= 20) break;
  }

  if (pa === 0) return null;

  const avg = ab > 0 ? +(h/ab).toFixed(3)  : 0;
  const slg = ab > 0 ? +(tb/ab).toFixed(3) : 0;
  const obp = (ab+bb) > 0 ? +((h+bb)/(ab+bb)).toFixed(3) : 0;

  // Flame tiers for last 20 PA
  let flame = '';
  if      (hr >= 4)               flame = '🔥🔥';
  else if (hr >= 2)               flame = '🔥';
  else if (pa >= 18 && slg < 0.250) flame = '❄️';

  // Return last 10 games for form blocks
  const gameLog = sorted.slice(0, 10).map(s => ({
    date:     s.date,
    opponent: s.opponent?.abbreviation || s.opponent?.name || '?',
    ab:       s.stat?.atBats        || 0,
    h:        s.stat?.hits          || 0,
    hr:       s.stat?.homeRuns      || 0,
    bb:       s.stat?.baseOnBalls   || 0,
    k:        s.stat?.strikeOuts    || 0,
    tb:       s.stat?.totalBases    || 0,
    rbi:      s.stat?.rbi           || 0,
    pa:       s.stat?.plateAppearances || 0,
  }));

  console.log(`${playerId}: ${games} games, ${pa} PA, ${hr} HR, slg=${slg}, flame=${flame}`);
  return { hr, avg, slg, obp, pa, games, flame, gameLog };
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
  const playerIds = {}; // include IDs for headshots
  const start = Date.now();

  // Process in batches of 15 concurrent requests
  for (let i = 0; i < names.length; i += 15) {
    const batch = names.slice(i, i+15);
    await Promise.allSettled(batch.map(async name => {
      try {
        const id = await searchPlayer(name);
        if (!id) return;
        playerIds[name] = id;
        const stats = await getLast20PA(id);
        if (stats) results[name] = stats;
      } catch(e) { console.warn(`Streak ${name}:`, e.message); }
    }));
  }

  console.log(`Streaks: ${Object.keys(results).length}/${names.length} in ${Date.now()-start}ms`);
  cache = { data: { streaks: results, playerIds }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=7200');
  return res.status(200).json({ streaks: results, playerIds, elapsed: Date.now()-start });
};
