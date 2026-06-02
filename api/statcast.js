// api/statcast.js — Vercel serverless function
const { fetchAllStatcast } = require('../lib/statcast');

let cache = { data: null, timestamp: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  try {
    const data = await fetchAllStatcast(2026);
    cache = { data, timestamp: Date.now() };
    return res.status(200).json(data);
  } catch (e) {
    console.error('Statcast fetch error:', e.message);
    if (cache.data) {
      return res.status(200).json({ ...cache.data, stale: true });
    }
    return res.status(500).json({ error: e.message });
  }
};
