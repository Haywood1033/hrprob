// api/slate.js — FAST endpoint (2-3 sec)
// Returns: today's schedule, probable pitchers, confirmed lineups, weather
// Called on every page load and every 5 minutes

const { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers } = require('../lib/lineups.js');
const { fetchAllWeather } = require('../lib/weather.js');

let cache = { data: null, timestamp: null, date: null };

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const today = new Date(etStr).toLocaleDateString('en-CA');
  const force = req.query.force === 'true';
  const age   = cache.timestamp ? (Date.now() - cache.timestamp) / 1000 : Infinity;

  // Cache valid for 5 minutes on same date
  if (!force && cache.date === today && age < 300 && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true, age: Math.round(age) });
  }

  const to = ms => new Promise(r => setTimeout(() => r(null), ms));
  const safe = (p, ms) => Promise.race([p.catch(() => null), to(ms)]);

  const start = Date.now();

  // Run all fast fetches in parallel — each has its own timeout
  const [pitchers, mlbLineups, rotoLineups, weather] = await Promise.all([
    safe(fetchProbablePitchers(today), 8000),
    safe(fetchMLBLineups(today),       7000),
    safe(fetchRotoWireLineups(),        7000),
    safe(fetchAllWeather(today),        8000),
  ]);

  const lineups     = mlbLineups || rotoLineups || {};
  const lineupSource = mlbLineups ? 'mlb.com' : rotoLineups ? 'rotowire.com' : 'none';
  const confirmedCount = Object.keys(lineups).length;

  console.log(`slate ${today}: ${pitchers?.length||0} games, ${confirmedCount} lineups from ${lineupSource}, ${Object.keys(weather||{}).length} wx parks, ${Date.now()-start}ms`);

  if (!pitchers?.length) {
    // Return empty but valid response — frontend handles gracefully
    return res.status(200).json({
      date: today, pitchers: [], lineups: {}, lineupSource: 'none',
      weather: weather || {}, confirmedCount: 0,
      timestamp: Date.now(), elapsed: Date.now() - start, error: 'MLB Stats API returned no games',
    });
  }

  const data = {
    date: today, pitchers, lineups, lineupSource,
    weather: weather || {}, confirmedCount,
    timestamp: Date.now(), elapsed: Date.now() - start,
  };

  cache = { data, timestamp: Date.now(), date: today };
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json(data);
};
