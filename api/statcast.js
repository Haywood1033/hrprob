// api/statcast.js — Vercel serverless function
// Fetches pitcher + batter Statcast data from Baseball Savant
// Uses lib/statcast.js for CSV parsing

const { fetchStatcast } = require('../lib/statcast');

let cache = { data: null, timestamp: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  // Return cached data if fresh
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    const data = await fetchStatcast(2026);
    cache = { data, timestamp: Date.now() };
    return res.status(200).json(data);
  } catch (e) {
    console.error('Statcast fetch error:', e.message);
    // Return stale cache if available
    if (cache.data) {
      return res.status(200).json({ ...cache.data, stale: true });
    }
    return res.status(500).json({ error: e.message });
  }
};
