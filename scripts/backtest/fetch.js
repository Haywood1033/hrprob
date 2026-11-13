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
      await sleep(3000 * (i + 1));
    }
  }
}

const savantUrl = d => 'https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfSea=&hfSit=&player_type=pitcher&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA='
  + `&game_date_gt=${d}&game_date_lt=${d}`
  + '&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&';

async function schedule(season) {
  const f = path.join(CACHE, `schedule-${season}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const d = await get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R`, 'json');
  const out = {};   // date -> { pk: startUTC }
  for (const day of d.dates || []) for (const g of day.games || []) {
    if (!['Final', 'Completed Early', 'Game Over'].includes(g.status?.detailedState) && g.status?.codedGameState !== 'F') continue;
    (out[day.date] ||= {})[g.gamePk] = g.gameDate;
  }
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

async function fetchDay(date) {
  const f = path.join(CACHE, 'days', `${date}.json`);
  if (fs.existsSync(f)) return 'cached';
  const rows = parseCSV(await get(savantUrl(date))).filter(r => r.game_type === 'R' || !r.game_type);
  if (rows.length >= 24900) console.warn(`  ! ${date}: ${rows.length} rows -- Savant caps a query near 25,000, this date may be truncated`);
  const games = aggregateDay(rows);
  if (!games.length) return 'empty';
  fs.writeFileSync(f, JSON.stringify({ date, games }));
  return `${games.length} games, ${rows.length} pitches`;
}

// One archive call per open-air park per season; keep the game-hour reading.
async function weather(season, sched, parks) {
  const f = path.join(CACHE, `weather-${season}.json`);
  if (fs.existsSync(f)) return;
  const dates = Object.keys(sched).sort();
  const out = {};
  const homeOf = {};
  for (const d of dates) {
    const p = path.join(CACHE, 'days', `${d}.json`);
    if (fs.existsSync(p)) for (const g of JSON.parse(fs.readFileSync(p, 'utf8')).games) homeOf[g.pk] = g.home;
  }
  for (const [team, park] of Object.entries(parks)) {
    if (!park.lat || park.roof !== 'open') continue;
    const d = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${park.lat}&longitude=${park.lon}`
      + `&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}`
      + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,relative_humidity_2m'
      + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT', 'json');
    const at = new Map(d.hourly.time.map((t, i) => [t, i]));
    for (const date of dates) for (const [pk, start] of Object.entries(sched[date])) {
      if (homeOf[pk] !== team) continue;
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

(async () => {
  const seasons = process.argv.slice(2).map(Number).filter(Boolean);
  if (!seasons.length) { console.error('usage: fetch.js <season> [season...]'); process.exit(1); }
  fs.mkdirSync(path.join(CACHE, 'days'), { recursive: true });
  const parks = JSON.parse(loadApp().run('JSON.stringify(PARKS)'));
  for (const season of seasons) {
    const sched = await schedule(season);
    const dates = Object.keys(sched).sort();
    console.log(`${season}: ${dates.length} dates`);
    let i = 0;
    const worker = async () => {
      while (i < dates.length) {
        const d = dates[i++];
        try { const r = await fetchDay(d); if (r !== 'cached') { console.log(`  ${d}: ${r}`); await sleep(500); } }
        catch (e) { console.error(`  ${d}: FAILED ${e.message}`); process.exitCode = 2; }
      }
    };
    await Promise.all([worker(), worker()]);
    await weather(season, sched, parks);
  }
})();
