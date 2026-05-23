// api/debug.js — test each data source independently
const { fetchProbablePitchers } = require('../lib/lineups.js');
const { fetchAllWeather } = require('../lib/weather.js');

module.exports = async function handler(req, res) {
  const results = { timestamp: new Date().toISOString(), tests: {} };

  // Test 1: ET date calculation
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const today = new Date(etStr).toLocaleDateString('en-CA');
  results.date = today;
  results.utc = new Date().toISOString();

  // Test 2: MLB Stats API
  try {
    const pitchers = await Promise.race([
      fetchProbablePitchers(today),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    results.tests.mlb_api = {
      ok: !!(pitchers?.length),
      games: pitchers?.length || 0,
      sample: pitchers?.[0] || null,
    };
  } catch(e) {
    results.tests.mlb_api = { ok: false, error: e.message };
  }

  // Test 3: Weather (just one park)
  try {
    const wx = await Promise.race([
      fetchAllWeather(today, ['Yankees']),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    results.tests.weather = { ok: !!(wx?.Yankees), sample: wx?.Yankees };
  } catch(e) {
    results.tests.weather = { ok: false, error: e.message };
  }

  // Test 4: Can we reach Baseball Savant at all?
  try {
    const r = await Promise.race([
      fetch('https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=2026&position=&team=&min=200&csv=true', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://baseballsavant.mlb.com/' }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
    ]);
    const text = await r.text();
    results.tests.savant = {
      ok: r.ok,
      status: r.status,
      rows: text.split('\n').length,
      preview: text.substring(0, 200),
    };
  } catch(e) {
    results.tests.savant = { ok: false, error: e.message };
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(results);
};
