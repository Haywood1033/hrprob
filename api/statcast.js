// api/statcast.js — SLOW endpoint (15-20 sec), cached 1 hour
// Returns: real Statcast EV, Barrel%, xwOBA, ISO for all batters + pitchers
// Called once on page load, refreshed hourly — never blocks game rendering

const { fetchAllStatcast } = require('../lib/statcast.js');

let cache = { data: null, timestamp: null, year: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const year  = parseInt(req.query.year || '2026');
  const force = req.query.force === 'true';
  const age   = cache.timestamp ? Date.now() - cache.timestamp : Infinity;

  // Return cache if fresh (< 1 hour) and same year
  if (!force && cache.year === year && age < CACHE_TTL && cache.data) {
    console.log(`statcast cache hit: ${Math.round(age/60000)}min old`);
    return res.status(200).json({ ...cache.data, cached: true, age: Math.round(age/1000) });
  }

  console.log(`statcast fetch starting for ${year}…`);
  const start = Date.now();

  const data = await fetchAllStatcast(year);

  if (!data) {
    // Return stale cache if available, otherwise error
    if (cache.data) {
      console.warn('Statcast fetch failed — returning stale cache');
      return res.status(200).json({ ...cache.data, stale: true, age: Math.round(age/1000) });
    }
    return res.status(503).json({ error: 'Baseball Savant unavailable', elapsed: Date.now()-start });
  }

  const batterCount  = Object.keys(data.batters || {}).length;
  const pitcherCount = Object.keys(data.pitchers || {}).length;
  console.log(`statcast loaded: ${batterCount} batters, ${pitcherCount} pitchers in ${Date.now()-start}ms`);

  cache = { data, timestamp: Date.now(), year };
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({ ...data, elapsed: Date.now()-start });
};
