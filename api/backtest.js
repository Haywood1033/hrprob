// api/backtest.js -- run the backtest on the deployed site.
//
//   GET  /api/backtest                      -> { results, status }
//   POST /api/backtest { action:'refresh' } -> downloads whatever is missing,
//        for as long as one request safely can, and says what is left.
//        Call it again until it answers { done: true }.
//   POST /api/backtest { action:'run' }     -> scores everything stored and
//        saves the results.
//
// A full first refresh is ~370 dates of Statcast data, far more than one
// serverless request can fetch, so the work is resumable: every date is
// stored as soon as it is downloaded and the next call picks up from there.
// If the BACKTEST_KEY environment variable is set, POST requires the same
// value in the x-backtest-key header.
'use strict';
const { Pool } = require('pg');
const S = require('../lib/backtest/sources.js');
const { packDay, unpackDay } = require('../lib/backtest/savant.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const query = (text, params) => pool.query(text, params);

const BUDGET_MS = 40000;                                   // leave headroom under maxDuration (60s)
const NET = { tries: 2, timeout: 25000, patient: false };  // fail fast; the next call retries
const etToday = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toLocaleDateString('en-CA');

async function getKey(key) {
  const { rows } = await query(`SELECT data, updated FROM backtest_cache WHERE key=$1`, [key]);
  return rows[0] || null;
}
const putKey = (key, data) => query(
  `INSERT INTO backtest_cache (key, data, updated) VALUES ($1, $2::jsonb, NOW())
   ON CONFLICT (key) DO UPDATE SET data=EXCLUDED.data, updated=NOW()`, [key, JSON.stringify(data)]);

// The two most recent seasons that have started.
function defaultSeasons() {
  const today = etToday(), y = +today.slice(0, 4);
  return today.slice(5) >= '04-01' ? [y - 1, y] : [y - 2, y - 1];
}

async function schedule(season, refetch) {
  const hit = await getKey(`schedule:${season}`);
  const current = season === +etToday().slice(0, 4);
  const stale = hit && current && Date.now() - new Date(hit.updated).getTime() > 6 * 3600e3;
  if (hit && !(refetch && stale)) return hit.data;
  const sched = await S.fetchSchedule(season, NET);
  await putKey(`schedule:${season}`, sched);
  return sched;
}

async function storedDates() {
  const { rows } = await query(`SELECT key FROM backtest_cache WHERE key LIKE 'day:%'`);
  return new Set(rows.map(r => r.key.slice(4)));
}

async function loadDays(season) {
  const { rows } = await query(`SELECT data FROM backtest_cache WHERE key LIKE $1`, [`day:${season}-%`]);
  return rows.map(r => unpackDay(r.data));
}

async function status(seasons, refetch = false) {
  const have = await storedDates(), today = etToday(), out = {};
  for (const s of seasons) {
    const sched = await schedule(s, refetch);
    const dates = Object.keys(sched).filter(d => d < today).sort();
    out[s] = { total: dates.length, have: dates.filter(d => have.has(d)).length, missing: dates.filter(d => !have.has(d)), sched };
  }
  return out;
}
const publicStatus = st => Object.fromEntries(Object.entries(st).map(([s, v]) => [s, { total: v.total, have: v.have }]));

async function refresh(seasons) {
  const start = Date.now(), left = () => BUDGET_MS - (Date.now() - start);
  const st = await status(seasons, true);
  const errors = [];

  // Step 1: game dates.
  const queue = Object.values(st).flatMap(v => v.missing.map(d => [d, v.sched[d]]));
  if (queue.length) {
    let i = 0, fetched = 0;
    const worker = async () => {
      while (i < queue.length && left() > 12000) {
        const [date, expected] = queue[i++];
        try {
          const day = S.aggregateChecked(date, await S.fetchDayCSV(date, NET), expected);
          await putKey(`day:${date}`, packDay(day));
          fetched++;
        } catch (e) { errors.push(`${date}: ${e.message}`); }
      }
    };
    await Promise.all([worker(), worker()]);
    const after = await status(seasons);
    const remaining = Object.values(after).reduce((n, v) => n + v.missing.length, 0);
    return { done: false, step: 'days', fetched, remaining, seasons: publicStatus(after), errors: errors.slice(0, 5) };
  }

  // Step 2: game-time weather, one archive call per open-air park.
  const { loadApp } = require('../lib/appSandbox.js');
  const parks = S.openParks(JSON.parse(loadApp().run('JSON.stringify(PARKS)')));
  const daysBySeason = {};
  for (const s of seasons) {
    const dates = Object.keys(st[s].sched).filter(d => d < etToday()).sort();
    if (!dates.length) continue;
    const through = dates[dates.length - 1];
    let w = (await getKey(`weather:${s}`))?.data;
    if (!w || w.through !== through) w = { through, parks: [], wx: w?.wx || {} };   // new games since last time
    const todo = parks.filter(([team]) => !w.parks.includes(team));
    if (!todo.length) continue;
    const days = daysBySeason[s] = await loadDays(s);
    const homeOf = {}; for (const d of days) for (const g of d.games) homeOf[g.pk] = g.home;
    const sched = Object.fromEntries(dates.map(d => [d, st[s].sched[d]]));
    const usual = S.usualVenues(sched, homeOf);
    for (const [team, park] of todo) {
      if (left() < 12000) break;
      try { Object.assign(w.wx, await S.fetchParkWeather(team, park, sched, homeOf, usual, NET)); w.parks.push(team); }
      catch (e) { errors.push(`weather ${team}: ${e.message}`); }
    }
    await putKey(`weather:${s}`, w);
    if (w.parks.length < parks.length) {
      return { done: false, step: 'weather', remaining: parks.length - w.parks.length, seasons: publicStatus(st), errors: errors.slice(0, 5) };
    }
  }

  // Step 3: roster bat sides for batters not seen before.
  const people = (await getKey('people'))?.data || {};
  const ids = new Set();
  for (const s of seasons) for (const d of daysBySeason[s] || await loadDays(s)) for (const g of d.games)
    for (const id of Object.keys(g.batters)) if (!(id in people)) ids.add(id);
  if (ids.size) {
    const got = await S.fetchPeople([...ids].slice(0, 1500), NET);
    for (const id of ids) people[id] = got[id] || people[id] || null;   // null = looked up, nothing listed
    await putKey('people', people);
  }
  return { done: true, step: 'ready', seasons: publicStatus(st), errors: errors.slice(0, 5) };
}

async function run(seasons) {
  const { scoreSeasons } = require('../lib/backtest/score.js');
  const people = (await getKey('people'))?.data || {};
  const input = {};
  for (const s of seasons) {
    const days = await loadDays(s);
    if (days.length) input[s] = { days, wx: (await getKey(`weather:${s}`))?.data?.wx || {}, people };
  }
  if (!Object.keys(input).length) throw new Error('Nothing stored yet -- run refresh first');
  const { results } = scoreSeasons(input);
  results.source = 'api';
  await putKey('results', results);
  return results;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await query(`CREATE TABLE IF NOT EXISTS backtest_cache (key TEXT PRIMARY KEY, data JSONB, updated TIMESTAMP DEFAULT NOW())`);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const seasons = (Array.isArray(body.seasons) && body.seasons.length ? body.seasons : defaultSeasons()).map(Number).filter(s => s >= 2015 && s <= 2100).slice(0, 3);

    if (req.method === 'GET') {
      const hit = await getKey('results');
      const have = await storedDates();
      return res.status(200).json({ results: hit?.data || null, updated: hit?.updated || null, storedDates: have.size, seasons });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    if (process.env.BACKTEST_KEY && req.headers['x-backtest-key'] !== process.env.BACKTEST_KEY) {
      return res.status(401).json({ error: 'This refresh needs the backtest key' });
    }
    if (body.action === 'refresh') return res.status(200).json(await refresh(seasons));
    if (body.action === 'run') return res.status(200).json({ ok: true, results: await run(seasons) });
    return res.status(400).json({ error: "action must be 'refresh' or 'run'" });
  } catch (e) {
    console.error('Backtest API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
module.exports._internals = { defaultSeasons };
