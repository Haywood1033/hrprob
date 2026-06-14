// api/statcast.js — Vercel serverless function
const { fetchAllStatcast } = require('../lib/statcast');

let cache = { data: null, timestamp: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  const force = req.query.force === 'true';
  if (!force && age < CACHE_TTL && cache.data && Object.keys(cache.data.batters||{}).length > 0) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    const data = await fetchAllStatcast(2026);
    if (!data) throw new Error('fetchAllStatcast returned null');

    const batterCount  = Object.keys(data.batters  || {}).length;
    const pitcherCount = Object.keys(data.pitchers || {}).length;
    console.log(`Statcast: ${batterCount} batters, ${pitcherCount} pitchers`);

    // Only cache if we got real data
    if (batterCount > 0) cache = { data, timestamp: Date.now() };

    return res.status(200).json(data);
  } catch (e) {
    console.error('Statcast fetch error:', e.message);
    // Return stale cache if available, otherwise empty structure
    if (cache.data) {
      return res.status(200).json({ ...cache.data, stale: true });
    }
    return res.status(200).json({ batters: {}, pitchers: {}, error: e.message });
  }
};
