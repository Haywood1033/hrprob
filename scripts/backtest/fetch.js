#!/usr/bin/env node
// Backfill to a local file cache: Statcast pitch-level data one date at a
// time (reduced to per-game batter/pitcher lines), game-time weather per
// park, and roster bat sides. Resumable -- cached dates are skipped.
//
//   node scripts/backtest/fetch.js 2025 2026
//
// Needs baseballsavant.mlb.com, statsapi.mlb.com and
// archive-api.open-meteo.com. The same pipeline runs on the deployed site
// through POST /api/backtest (see api/backtest.js).
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = require('../../lib/backtest/sources.js');
const { loadApp } = require('../../lib/appSandbox.js');

const CACHE = path.join(__dirname, '..', '..', 'data', 'backtest', 'cache');
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));

async function schedule(season) {
  const f = path.join(CACHE, `schedule-v2-${season}.json`);
  if (fs.existsSync(f)) return readJSON(f);
  const out = await S.fetchSchedule(season);
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

// Delete cache/days to re-aggregate from cache/raw without re-downloading.
async function fetchDay(date, expected) {
  const f = path.join(CACHE, 'days', `${date}.json`);
  if (fs.existsSync(f)) return 'cached';
  // The raw CSV is kept (gzipped) so a change to the aggregation can be
  // replayed without asking Savant for the season again.
  const rawF = path.join(CACHE, 'raw', `${date}.csv.gz`);
  const cached = fs.existsSync(rawF);
  const text = cached ? zlib.gunzipSync(fs.readFileSync(rawF)).toString('utf8') : await S.fetchDayCSV(date);
  const day = S.aggregateChecked(date, text, expected);
  if (day.truncated) console.warn(`  ! ${date}: ${day.pitches} rows -- Savant caps a query near 25,000, this date may be truncated`);
  if (!cached) fs.writeFileSync(rawF, zlib.gzipSync(text));
  fs.writeFileSync(f, JSON.stringify({ date, games: day.games }));
  return `${day.games.length} games, ${day.pitches} pitches`;
}

async function weather(season, sched, parks) {
  const f = path.join(CACHE, `weather-${season}.json`);   // delete to rebuild
  if (fs.existsSync(f)) return;
  const homeOf = {};
  for (const d of Object.keys(sched)) {
    const p = path.join(CACHE, 'days', `${d}.json`);
    if (fs.existsSync(p)) for (const g of readJSON(p).games) homeOf[g.pk] = g.home;
  }
  const usual = S.usualVenues(sched, homeOf), out = {};
  for (const [team, park] of S.openParks(parks)) {
    Object.assign(out, await S.fetchParkWeather(team, park, sched, homeOf, usual));
    console.log(`  weather ${season} ${team}`);
    await S.sleep(400);
  }
  fs.writeFileSync(f, JSON.stringify(out));
}

async function people() {
  const f = path.join(CACHE, 'people.json');
  const known = fs.existsSync(f) ? readJSON(f) : {};
  const ids = new Set();
  for (const d of fs.readdirSync(path.join(CACHE, 'days')))
    for (const g of readJSON(path.join(CACHE, 'days', d)).games)
      for (const id of Object.keys(g.batters)) if (!known[id]) ids.add(id);
  Object.assign(known, await S.fetchPeople([...ids]));
  fs.writeFileSync(f, JSON.stringify(known));
  console.log(`people: ${Object.keys(known).length} batters with a roster bat side (${ids.size} looked up)`);
}

(async () => {
  const seasons = process.argv.slice(2).map(Number).filter(Boolean);
  if (!seasons.length) { console.error('usage: fetch.js <season> [season...]'); process.exit(1); }
  fs.mkdirSync(path.join(CACHE, 'days'), { recursive: true });
  fs.mkdirSync(path.join(CACHE, 'raw'), { recursive: true });
  const parks = JSON.parse(loadApp().run('JSON.stringify(PARKS)'));
  for (const season of seasons) {
    const sched = await schedule(season);
    const dates = Object.keys(sched).sort();
    console.log(`${season}: ${dates.length} dates`);
    let i = 0;
    const worker = async () => {
      while (i < dates.length) {
        const d = dates[i++];
        try { const r = await fetchDay(d, sched[d]); if (r !== 'cached') { console.log(`  ${d}: ${r}`); await S.sleep(500); } }
        catch (e) { console.error(`  ${d}: FAILED ${e.message}`); process.exitCode = 2; }
      }
    };
    await Promise.all([worker(), worker()]);
    if (process.exitCode) { console.error(`  ${season}: some dates failed -- weather skipped until a re-run completes them`); continue; }
    await weather(season, sched, parks);
  }
  await people();
})();
