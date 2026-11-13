// Where the backtest's data comes from: MLB schedule, Statcast pitch-level
// CSV, Open-Meteo archive weather and roster bat sides. Network only -- no
// storage -- so the CLI (file cache) and the API (database) share it.
'use strict';
const { parseCSV, aggregateDay } = require('./savant.js');

const UA = { 'User-Agent': 'Mozilla/5.0 (backtest)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// opts.tries / opts.timeout let the API keep inside a serverless time limit.
async function get(url, as = 'text', { tries = 4, timeout = 120000, patient = true } = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return as === 'json' ? await r.json() : await r.text();
    } catch (e) {
      if (i >= tries - 1) throw new Error(`${e.message} for ${new URL(url).hostname}`);
      // Back off harder when Savant is rate-limiting or erroring.
      await sleep((patient && /HTTP (429|5\d\d)/.test(e.message) ? 20000 : 3000) * (i + 1));
    }
  }
}

const savantUrl = d => 'https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfPT=&hfAB=&hfBBT=&hfPR=&hfZ=&stadium=&hfBBL=&hfNewZones=&hfGT=R%7C&hfSea=&hfSit=&player_type=pitcher&hfOuts=&opponent=&pitcher_throws=&batter_stands=&hfSA='
  + `&game_date_gt=${d}&game_date_lt=${d}`
  + '&team=&position=&hfRO=&home_road=&hfFlag=&metric_1=&hfInn=&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=h_launch_speed&sort_order=desc&min_abs=0&type=details&';

// date -> { pk: { start, venue } } for completed regular-season games. A
// suspended game is listed on both the day it started and the day it
// resumed; Savant files all of it under the official (original) date, so
// key on officialDate and keep the first start.
async function fetchSchedule(season, opts) {
  const d = await get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R`, 'json', opts);
  const out = {};
  for (const day of d.dates || []) for (const g of day.games || []) {
    if (!['Final', 'Completed Early', 'Game Over'].includes(g.status?.detailedState) && g.status?.codedGameState !== 'F') continue;
    const slot = (out[g.officialDate || day.date] ||= {});
    if (!slot[g.gamePk] || g.gameDate < slot[g.gamePk].start) slot[g.gamePk] = { start: g.gameDate, venue: g.venue?.id ?? null };
  }
  return out;
}

async function fetchDayCSV(date, opts) {
  const text = await get(savantUrl(date), 'text', opts);
  if (!/^﻿?"?pitch_type"?,/.test(text)) throw new Error('Savant did not return a CSV');
  return text;
}

// CSV text -> { date, games, pitches }. Every date comes from the schedule
// of completed games, so an empty or short answer is a failed download, not
// an off day: throw rather than let it be cached.
function aggregateChecked(date, text, expected) {
  const rows = parseCSV(text).filter(r => r.game_type === 'R' || !r.game_type);
  const games = aggregateDay(rows);
  const missing = Object.keys(expected).filter(pk => !games.some(g => g.pk === +pk));
  if (missing.length) throw new Error(`Savant returned ${games.length} of ${Object.keys(expected).length} scheduled games (missing ${missing.join(',')})`);
  return { date, games, pitches: rows.length, truncated: rows.length >= 24900 };
}

// Neutral-site games (Tokyo, Bristol, Williamsport...) are not played at the
// home team's PARKS coordinates: they get no weather rather than the wrong
// city's. "Usual" venue = the one the team hosted most games at.
function usualVenues(sched, homeOf) {
  const count = {};
  for (const d of Object.keys(sched)) for (const [pk, g] of Object.entries(sched[d])) {
    const t = homeOf[pk]; if (!t || g.venue == null) continue;
    ((count[t] ||= {})[g.venue] ||= 0); count[t][g.venue]++;
  }
  return Object.fromEntries(Object.entries(count).map(([t, c]) => [t, +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]]));
}

// One archive call for one open-air park; returns { pk: wx } at each game hour.
async function fetchParkWeather(team, park, sched, homeOf, usual, opts) {
  const dates = Object.keys(sched).sort(), out = {};
  const d = await get(`https://archive-api.open-meteo.com/v1/archive?latitude=${park.lat}&longitude=${park.lon}`
    + `&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}`
    + '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,relative_humidity_2m'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT', 'json', opts);
  const at = new Map(d.hourly.time.map((t, i) => [t, i]));
  for (const date of dates) for (const [pk, { start, venue }] of Object.entries(sched[date])) {
    if (homeOf[pk] !== team || venue !== usual[team]) continue;
    const i = at.get(start.slice(0, 13) + ':00');
    if (i == null || d.hourly.temperature_2m[i] == null) continue;
    out[pk] = { t: Math.round(d.hourly.temperature_2m[i]), ws: Math.round(d.hourly.wind_speed_10m[i]),
      wd: d.hourly.wind_direction_10m[i], pres: Math.round(d.hourly.surface_pressure[i]),
      hum: Math.round(d.hourly.relative_humidity_2m[i]) };
  }
  return out;
}

const openParks = parks => Object.entries(parks).filter(([, p]) => p.lat && p.roof === 'open');

// Roster bat side. A switch hitter usually bats from one side all game, so
// the pitch data alone would label him L or R and the model would hand him
// a platoon edge the live app (bats: 'S') does not.
async function fetchPeople(ids, opts) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const d = await get(`https://statsapi.mlb.com/api/v1/people?personIds=${ids.slice(i, i + 100).join(',')}&fields=people,id,batSide,code`, 'json', opts);
    for (const p of d.people || []) if (p.batSide?.code) out[p.id] = p.batSide.code;
    await sleep(300);
  }
  return out;
}

module.exports = { get, sleep, fetchSchedule, fetchDayCSV, aggregateChecked, usualVenues, fetchParkWeather, openParks, fetchPeople };
