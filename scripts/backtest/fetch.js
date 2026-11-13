#!/usr/bin/env node
// Backfill: downloads Statcast pitch-level data one date at a time,
// reduces each date to per-game batter/pitcher lines, and stores game-time
// weather per park. Resumable -- dates already in the cache are skipped.
//
//   node scripts/backtest/fetch.js 2025 2026
//
// Needs network access to baseballsavant.mlb.com, statsapi.mlb.com and
// archive-api.open-meteo.com.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { parseCSV, aggregateDay } = require('./savant.js');
const { loadApp } = require('../../tests/lib/loadApp.js');

const CACHE = path.join(__dirname, '..', '..', 'data', 'backtest', 'cache');
const UA = { 'User-Agent': 'Mozilla/5.0 (backtest)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, as = 'text', tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (i >= tries - 1) throw new Error(`${e.message} for ${url}`);
      // Back off harder when Savant is rate-limiting or erroring.
      await sleep((/HTTP (429|5\d\d)/.test(e.message) ? 20000 : 3000) * (i + 1));
    }
  }
}

const savantUrl = d => 'https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfSea=&hfSit=&player_type=pitcher&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA='
  + `&game_date_gt=${d}&game_date_lt=${d}`
  + '&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&';

async function schedule(season) {
  const f = path.join(CACHE, `schedule-v2-${season}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const d = await get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R`, 'json');
  // date -> { pk: { start, venue } }. A suspended game is listed on both the
  // day it started and the day it resumed; Savant files all of it under the
  // official (original) date, so key on officialDate and keep the first start.
  const out = {};
  for (const day of d.dates || []) for (const g of day.games || []) {
    if (!['Final', 'Completed Early', 'Game Over'].includes(g.status?.detailedState) && g.status?.codedGameState !== 'F') continue;
    const slot = (out[g.officialDate || day.date] ||= {});
    if (!slot[g.gamePk] || g.gameDate < slot[g.gamePk].start) slot[g.gamePk] = { start: g.gameDate, venue: g.venue?.id ?? null };
  }
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
  let text;
  if (fs.existsSync(rawF)) text = zlib.gunzipSync(fs.readFileSync(rawF)).toString('utf8');
  else {
    text = await get(savantUrl(date));
    if (!/^\uFEFF?"?pitch_type"?,/.test(text)) throw new Error('Savant did not return a CSV');
  }
  const rows = parseCSV(text).filter(r => r.game_type === 'R' || !r.game_type);
  if (rows.length >= 24900) console.warn(`  ! ${date}: ${rows.length} rows -- Savant caps a query near 25,000, this date may be truncated`);
  const games = aggregateDay(rows);
  // Every date comes from the schedule of completed games, so an empty or
  // short answer is a failed download, not an off day. Do not cache it.
  const missing = Object.keys(expected).filter(pk => !games.some(g => g.pk === +pk));
  if (missing.length) throw new Error(`Savant returned ${games.length} of ${Object.keys(expected).length} scheduled games (missing ${missing.join(',')})`);
  if (!fs.existsSync(rawF)) fs.writeFileSync(rawF, zlib.gzipSync(text));
  fs.writeFileSync(f, JSON.stringify({ date, games }));
  return `${games.length} games, ${rows.length} pitches`;
}

// One archive call per open-air park per season; keep the game-hour reading.
async function weather(season, sched, parks) {
  const f = path.join(CACHE, `weather-${season}.json`);   // delete to rebuild
  if (fs.existsSync(f)) return;
  const dates = Object.keys(sched).sort();
  const out = {};
  const homeOf = {};
  for (const d of dates) {
    const p = path.join(CACHE, 'days', `${d}.json`);
    if (fs.existsSync(p)) for (const g of JSON.parse(fs.readFileSync(p, 'utf8')).games) homeOf[g.pk] = g.home;
  }
  // Neutral-site games (Tokyo, Bristol, Williamsport...) are not played at
  // the home team's PARKS coordinates: give them no weather rather than the
  // wrong city's. "Usual" venue = the one the team hosted most games at.
  const venueCount = {};
  for (const d of dates) for (const [pk, g] of Object.entries(sched[d])) {
    const t = homeOf[pk]; if (!t || g.venue == null) continue;
    ((venueCount[t] ||= {})[g.venue] ||= 0); venueCount[t][g.venue]++;
  }
  const usual = Object.fromEntries(Object.entries(venueCount).map(([t, c]) => [t, +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]]));
  for (const [team, park] of Object.entries(parks)) {
    if (!park.lat || park.roof !== 'open') continue;
    const d = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${park.lat}&longitude=${park.lon}`
      + `&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}`
      + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,relative_humidity_2m'
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT', 'json');
    const at = new Map(d.hourly.time.map((t, i) => [t, i]));
    for (const date of dates) for (const [pk, { start, venue }] of Object.entries(sched[date])) {
      if (homeOf[pk] !== team || venue !== usual[team]) continue;
      const i = at.get(start.slice(0, 13) + ':00');
      if (i == null || d.hourly.temperature_2m[i] == null) continue;
      out[pk] = { t: Math.round(d.hourly.temperature_2m[i]), ws: Math.round(d.hourly.wind_speed_10m[i]),
        wd: d.hourly.wind_direction_10m[i], pres: Math.round(d.hourly.surface_pressure[i]),
        hum: Math.round(d.hourly.relative_humidity_2m[i]) };
    }
    console.log(`  weather ${season} ${team}`);
    await sleep(400);
  }
  fs.writeFileSync(f, JSON.stringify(out));
}

// Roster bat side for every batter seen. A switch hitter usually bats from
// one side all game, so the pitch data alone would label him L or R and the
// model would hand him a platoon edge the live app (bats: 'S') does not.
async function people() {
  const f = path.join(CACHE, 'people.json');
  const known = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  const ids = new Set();
  for (const d of fs.readdirSync(path.join(CACHE, 'days')))
    for (const g of JSON.parse(fs.readFileSync(path.join(CACHE, 'days', d), 'utf8')).games)
      for (const id of Object.keys(g.batters)) if (!known[id]) ids.add(id);
  const todo = [...ids];
  for (let i = 0; i < todo.length; i += 100) {
    const d = await get(`https://statsapi.mlb.com/api/v1/people?personIds=${todo.slice(i, i + 100).join(',')}&fields=people,id,batSide,code`, 'json');
    for (const p of d.people || []) if (p.batSide?.code) known[p.id] = p.batSide.code;
    await sleep(300);
  }
  fs.writeFileSync(f, JSON.stringify(known));
  console.log(`people: ${Object.keys(known).length} batters with a roster bat side (${todo.length} looked up)`);
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
        try { const r = await fetchDay(d, sched[d]); if (r !== 'cached') { console.log(`  ${d}: ${r}`); await sleep(500); } }
        catch (e) { console.error(`  ${d}: FAILED ${e.message}`); process.exitCode = 2; }
      }
    };
    await Promise.all([worker(), worker()]);
    if (process.exitCode) { console.error(`  ${season}: some dates failed -- weather skipped until a re-run completes them`); continue; }
    await weather(season, sched, parks);
  }
  await people();
})();
