// Backtest plumbing: Statcast aggregation, the no-leak guarantee, and the
// calibration maths. Synthetic data only -- no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, aggregateDay } = require('../scripts/backtest/savant.js');
const { buildRows, streakFeatures } = require('../scripts/backtest/features.js');
const M = require('../scripts/backtest/metrics.js');

const HEAD = 'game_date,game_pk,batter,pitcher,player_name,events,description,stand,p_throws,home_team,away_team,inning_topbot,at_bat_number,pitch_number,launch_speed,launch_angle,launch_speed_angle,bb_type,hc_x,hc_y,estimated_woba_using_speedangle,woba_value,woba_denom,game_type';
const pitch = (o) => [o.date, o.pk || 1, o.batter, o.pitcher || 900, '"Doe, John"', o.events || '', o.description || 'ball', o.stand || 'R', 'R', 'NYY', 'BOS',
  o.top ? 'Top' : 'Bot', o.ab, o.n || 1, o.ls ?? '', o.la ?? '', o.lsa ?? '', o.bb || '', o.hx ?? '', o.hy ?? '', o.xw ?? '', o.wv ?? '', o.events ? 1 : '', 'R'].join(',');

// One game: nine batters a side, batter 1 (home) homers when hr=true.
function gameCSV(date, pk, hr) {
  const rows = [HEAD];
  let ab = 0;
  for (const top of [true, false]) for (let i = 1; i <= 9; i++) {
    const batter = (top ? 100 : 0) + i, pitcher = top ? 900 : 901;
    ab++;
    rows.push(pitch({ date, pk, batter, pitcher, top, ab, n: 1, description: 'swinging_strike' }));
    if (!top && i === 1 && hr) rows.push(pitch({ date, pk, batter, pitcher, top, ab, n: 2, events: 'home_run', description: 'hit_into_play', ls: 108, la: 28, lsa: 6, bb: 'fly_ball', hx: 60, hy: 60, xw: 1.9, wv: 2 }));
    else rows.push(pitch({ date, pk, batter, pitcher, top, ab, n: 2, events: 'field_out', description: 'hit_into_play', ls: 85, la: -5, lsa: 2, bb: 'ground_ball', hx: 130, hy: 150, xw: 0.1, wv: 0 }));
  }
  return rows.join('\n');
}
const day = (date, pk, hr) => ({ date, games: aggregateDay(parseCSV(gameCSV(date, pk, hr))) });

test('aggregateDay: counts PA, HR, barrels, whiffs, lineup order and starters', () => {
  const [g] = day('2026-04-01', 1, true).games;
  assert.equal(g.home, 'Yankees'); assert.equal(g.away, 'Red Sox');
  assert.deepEqual(g.lineup.home, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(g.starter.home, 900);        // home starter faces the away (top) batters
  assert.equal(g.starter.away, 901);
  const b = g.batters[1];
  assert.equal(b.pa, 1); assert.equal(b.hr, 1); assert.equal(b.brl, 1); assert.equal(b.hh, 1);
  assert.equal(b.fb, 1); assert.equal(b.pull, 1); assert.equal(b.sw, 2); assert.equal(b.wh, 1);
  assert.equal(g.pitchers[901].hr, 1); assert.equal(g.pitchers[901].outs, 8);
});

test('buildRows: a game\'s own result never reaches its features', () => {
  const rows = buildRows([day('2026-04-01', 1, true)]);
  const r = rows.find(x => x.batter === 1);
  assert.equal(r.hr, 1);
  assert.equal(r.b.pa, 0, 'first game of the season has no history');
  assert.equal(r.streak, null);
});

test('buildRows: changing a later date leaves earlier rows untouched (no leakage)', () => {
  const base = [day('2026-04-01', 1, false), day('2026-04-02', 2, false)];
  const withFuture = [day('2026-04-01', 1, false), day('2026-04-02', 2, true), day('2026-04-03', 3, true)];
  const strip = rows => rows.filter(r => r.date <= '2026-04-02').map(r => ({ ...r, hr: null, pa: null }));
  assert.deepEqual(strip(buildRows(withFuture)), strip(buildRows(base)));
});

test('buildRows: yesterday\'s homer shows up in today\'s features', () => {
  const rows = buildRows([day('2026-04-01', 1, true), day('2026-04-02', 2, false)]);
  const r = rows.find(x => x.batter === 1 && x.date === '2026-04-02');
  assert.equal(r.b.pa, 1); assert.equal(r.b.ba, 100); assert.equal(r.b.iso, 3); assert.equal(r.hr, 0);
  assert.equal(r.streak.hr, 1);
});

test('streakFeatures: 20-PA window flags hot and cold like api/streaks.js', () => {
  assert.equal(streakFeatures(Array(5).fill({ pa: 4, ab: 4, tb: 4, hr: 1 })).flame, '🔥🔥');
  assert.equal(streakFeatures(Array(5).fill({ pa: 4, ab: 4, tb: 0, hr: 0 })).flame, '❄️');
  assert.equal(streakFeatures([]), null);
});

test('metrics: a perfect forecast has skill 1, the base rate has skill 0', () => {
  const ys = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  assert.ok(Math.abs(M.score(ys.map(() => 0.2), ys).brierSkill) < 1e-9);
  assert.ok(M.score(ys.map(y => y ? 0.999 : 0.001), ys).brierSkill > 0.99);
  assert.equal(M.auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
});

test('isotonicKnots: output is monotone and repairs an overconfident top end', () => {
  const ps = [], ys = [];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 40000; i++) {
    const p = 0.03 + rnd() * 0.25, truth = p < 0.15 ? p : 0.15 + (p - 0.15) * 0.2;
    ps.push(p); ys.push(rnd() < truth ? 1 : 0);
  }
  const k = M.isotonicKnots(ps, ys);
  for (let i = 1; i < k.length; i++) { assert.ok(k[i][0] > k[i - 1][0]); assert.ok(k[i][1] >= k[i - 1][1]); }
  assert.ok(Math.abs(M.applyKnots(k, 0.08) - 0.08) < 0.02);
  assert.ok(M.applyKnots(k, 0.26) < 0.20, 'top end is pulled down');
  assert.ok(M.applyKnots(k, 0.27) >= M.applyKnots(k, 0.20), 'never inverts the ranking');
});
