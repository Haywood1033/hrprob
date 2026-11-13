// /api/backtest end to end against an in-memory database and fake data
// sources: refresh resumes until done, run scores what was stored.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const db = new Map();
class Pool {
  async query(sql, p = []) {
    if (/^\s*CREATE/.test(sql)) return { rows: [] };
    if (/INSERT INTO backtest_cache/.test(sql)) { db.set(p[0], { data: JSON.parse(p[1]), updated: new Date() }); return { rows: [] }; }
    if (/SELECT data, updated/.test(sql)) return { rows: db.has(p[0]) ? [db.get(p[0])] : [] };
    if (/SELECT key FROM/.test(sql)) return { rows: [...db.keys()].filter(k => k.startsWith('day:')).map(key => ({ key })) };
    if (/SELECT data FROM/.test(sql)) { const pre = p[0].replace('%', ''); return { rows: [...db.entries()].filter(([k]) => k.startsWith(pre)).map(([, v]) => ({ data: v.data })) }; }
    throw new Error('unexpected SQL: ' + sql);
  }
}
const realLoad = Module._load;
Module._load = (req, ...rest) => req === 'pg' ? { Pool } : realLoad(req, ...rest);
const handler = require('../api/backtest.js');
Module._load = realLoad;

const HEAD = 'pitch_type,game_date,game_pk,batter,pitcher,player_name,events,description,stand,p_throws,home_team,away_team,inning_topbot,at_bat_number,pitch_number,launch_speed,launch_angle,launch_speed_angle,bb_type,hc_x,hc_y,estimated_woba_using_speedangle,woba_value,woba_denom,game_type';
function csv(date, pks) {
  const rows = [HEAD];
  for (const pk of pks) { let ab = 0;
    for (const top of [true, false]) for (let i = 1; i <= 9; i++) { ab++;
      const hr = (pk + i) % 7 === 0;
      rows.push(['FF', date, pk, (top ? 100 : 0) + i, top ? 900 : 901, 'x', hr ? 'home_run' : 'field_out', 'hit_into_play', 'R', 'R', 'NYY', 'BOS', top ? 'Top' : 'Bot', ab, 1,
        hr ? 106 : 88, hr ? 27 : 5, hr ? 6 : 2, hr ? 'fly_ball' : 'ground_ball', 100, 100, hr ? 1.8 : 0.2, hr ? 2 : 0, 1, 'R'].join(','));
    } }
  return rows.join('\n');
}
const DATES = { 2025: ['2025-04-01', '2025-04-02'], 2026: ['2026-04-01', '2026-04-02', '2026-04-03'] };
let savantCalls = 0, failures = 2;   // one download fails through its retry
const realFetch = global.fetch;
function fakeFetch(url) {
  const u = new URL(url), ok = (body, json) => Promise.resolve({ ok: true, json: async () => body, text: async () => body });
  if (u.hostname === 'statsapi.mlb.com' && u.pathname.endsWith('/schedule')) {
    const s = u.searchParams.get('season');
    return ok({ dates: DATES[s].map((date, i) => ({ date, games: [{ gamePk: +s * 10 + i, officialDate: date, gameDate: date + 'T23:05:00Z', venue: { id: 3313 }, status: { codedGameState: 'F', detailedState: 'Final' } }] })) });
  }
  if (u.hostname === 'baseballsavant.mlb.com') {
    savantCalls++;
    const date = u.searchParams.get('game_date_gt');
    if (date === '2026-04-02' && failures-- > 0) { return Promise.resolve({ ok: false, status: 503 }); }
    const s = date.slice(0, 4);
    return ok(csv(date, [+s * 10 + DATES[s].indexOf(date)]));
  }
  if (u.hostname === 'archive-api.open-meteo.com') {
    const time = [], t = [];
    for (const d of [...DATES[2025], ...DATES[2026]]) { time.push(d + 'T23:00'); t.push(71); }
    return ok({ hourly: { time, temperature_2m: t, wind_speed_10m: t.map(() => 9), wind_direction_10m: t.map(() => 0), surface_pressure: t.map(() => 1011), relative_humidity_2m: t.map(() => 55) } });
  }
  if (u.hostname === 'statsapi.mlb.com' && u.pathname.endsWith('/people')) {
    return ok({ people: u.searchParams.get('personIds').split(',').map(id => ({ id: +id, batSide: { code: +id === 1 ? 'S' : 'R' } })) });
  }
  return Promise.reject(new Error('unexpected fetch ' + url));
}
async function call(method, body, headers = {}) {
  let status = 0, json = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(j) { json = j; return this; } };
  await handler({ method, body, headers, query: {} }, res);
  return { status, json };
}

test('api/backtest: refresh resumes to done, run stores results, GET serves them', async (t) => {
  global.fetch = fakeFetch;
  t.after(() => { global.fetch = realFetch; });
  const seasons = [2025, 2026];

  let r = await call('POST', { action: 'refresh', seasons });
  assert.equal(r.status, 200);
  assert.equal(r.json.step, 'days');
  assert.equal(r.json.remaining, 1, 'the date whose download failed is still owed');
  assert.match(r.json.errors[0], /2026-04-02/);
  assert.equal(db.has('day:2026-04-02'), false, 'a failed download is never stored');

  let guard = 0;
  while (!r.json.done && guard++ < 8) r = await call('POST', { action: 'refresh', seasons });
  assert.equal(r.json.done, true);
  assert.deepEqual(r.json.seasons, { 2025: { total: 2, have: 2 }, 2026: { total: 3, have: 3 } });
  assert.equal(db.get('people').data['1'], 'S');
  assert.equal(db.get('weather:2026').data.wx['20260'].wd, 0, 'a due-north wind is kept as 0');

  const before = savantCalls;
  r = await call('POST', { action: 'refresh', seasons });
  assert.equal(r.json.done, true);
  assert.equal(savantCalls, before, 'nothing is downloaded twice');

  r = await call('POST', { action: 'run', seasons });
  assert.equal(r.status, 200);
  assert.equal(r.json.results.rows, 5 * 18);
  assert.deepEqual(r.json.results.seasons, ['2025', '2026']);
  assert.ok(Number.isFinite(r.json.results.all.streak.brier));

  r = await call('GET');
  assert.equal(r.json.results.rows, 90);
  assert.equal(r.json.storedDates, 5);
});

test('api/backtest: POST needs the key when one is configured', async () => {
  process.env.BACKTEST_KEY = 'secret';
  try {
    assert.equal((await call('POST', { action: 'run' })).status, 401);
    assert.equal((await call('GET')).status, 200);
  } finally { delete process.env.BACKTEST_KEY; }
});
