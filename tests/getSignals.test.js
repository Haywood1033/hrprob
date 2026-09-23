// Regression tests for getSignals() — the 8-signal convergence system
// (CLAUDE.md: app.html ~line 2625) and its Elite/All-Star/Value badge
// thresholds. Unlike hrProb(), getSignals() reads several module-level
// data stores (BATTER, WX, PARKS, STREAK, ...) keyed by player/team name
// instead of taking plain arguments, so each test seeds fresh, uniquely
// named fixtures into those stores via app.run(...) rather than resetting
// global state between tests.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/loadApp.js');

const app = loadApp();
let seq = 0;
function uniqueName(label) { return `${label} ${++seq}`; }

// Seeds PARKS/WX/BATTER/STREAK for one synthetic team+player and returns
// the row object getSignals(r) expects. Callers pass overrides for just
// the fields they care about; everything else defaults to signal-inactive
// values so each test only lights up the signal(s) it's checking.
function makeRow({ team, park = {}, wx = {}, batter = {}, pit = {}, streak = null, hrp = 10 } = {}) {
  const t = team || uniqueName('Team');
  const name = uniqueName('Player');
  const parkFixture = { f: 1.0, roof: 'open', orient: 180, ...park };
  const wxFixture = { ws: 0, wd: 180, ...wx };
  const batterFixture = { pa: 10, xw: 0.310, ...batter }; // low pa by default -> confidence signal off
  app.run(`PARKS[${JSON.stringify(t)}] = ${JSON.stringify(parkFixture)}`);
  app.run(`WX[${JSON.stringify(t)}] = ${JSON.stringify(wxFixture)}`);
  app.run(`BATTER[${JSON.stringify(name)}] = ${JSON.stringify(batterFixture)}`);
  if (streak) app.run(`STREAK[${JSON.stringify(name)}] = ${JSON.stringify(streak)}`);
  return { name, team: t, pit, hrp };
}

function getSignals(row) {
  return app.run(`getSignals(${JSON.stringify(row)})`);
}

test('signal: Hitter Park fires at park factor >= 1.05, not below', () => {
  const active = getSignals(makeRow({ park: { f: 1.05 } }));
  const inactive = getSignals(makeRow({ park: { f: 1.04 } }));
  assert.strictEqual(active.signals.find(s => s.key === 'park').active, true);
  assert.strictEqual(inactive.signals.find(s => s.key === 'park').active, false);
});

test('signal: Wind Out requires non-dome, wind blowing out, and ws >= 6', () => {
  // wx.wd is meteorological wind direction (source, not travel direction).
  // orient defaults to 180 -- wd:0 means wind sourced from the opposite
  // bearing (behind home plate), diff=180, which carries the ball OUT.
  // wd:180 (diff=0) means wind sourced from the park's own CF bearing,
  // blowing FROM center field back toward home plate, i.e. blowing in.
  const active = getSignals(makeRow({ wx: { ws: 6, wd: 0 } })); // diff=180 -> out
  const tooLight = getSignals(makeRow({ wx: { ws: 5, wd: 0 } }));
  const blowingIn = getSignals(makeRow({ wx: { ws: 15, wd: 180 } })); // diff=0 -> in
  const domed = getSignals(makeRow({ park: { roof: 'dome' }, wx: { ws: 15, wd: 0 } }));
  assert.strictEqual(active.signals.find(s => s.key === 'weather').active, true);
  assert.strictEqual(tooLight.signals.find(s => s.key === 'weather').active, false, 'below 6mph should not fire');
  assert.strictEqual(blowingIn.signals.find(s => s.key === 'weather').active, false, 'wind blowing in should not fire');
  assert.strictEqual(domed.signals.find(s => s.key === 'weather').active, false, 'domed roof should not fire regardless of wind');
});

test('signal: Pitcher Matchup fires at xERA >= 4.80 or HR/9 >= 1.40 against a competent batter', () => {
  const weakXera = getSignals(makeRow({ pit: { xera: 4.80, hr9: 1.0 }, batter: { xw: 0.310 } }));
  const weakHr9 = getSignals(makeRow({ pit: { xera: 3.50, hr9: 1.40 }, batter: { xw: 0.310 } }));
  const strongPitcher = getSignals(makeRow({ pit: { xera: 3.00, hr9: 0.90 }, batter: { xw: 0.310 } }));
  assert.strictEqual(weakXera.signals.find(s => s.key === 'pitcher').active, true);
  assert.strictEqual(weakHr9.signals.find(s => s.key === 'pitcher').active, true);
  assert.strictEqual(strongPitcher.signals.find(s => s.key === 'pitcher').active, false);
});

test('signal: Pitcher Matchup does not fire for a weak-hitting batter even against a bad pitcher', () => {
  const row = makeRow({ pit: { xera: 6.00, hr9: 2.00 }, batter: { xw: 0.200 } }); // batterQuality requires xw>=0.270
  const result = getSignals(row);
  assert.strictEqual(result.signals.find(s => s.key === 'pitcher').active, false);
});

test('signal: Hot Streak fires on single or double flame, not on no streak data', () => {
  const hot = getSignals(makeRow({ streak: { flame: '🔥' } }));
  const scorching = getSignals(makeRow({ streak: { flame: '🔥🔥' } }));
  const cold = getSignals(makeRow({ streak: { flame: '❄️' } }));
  const none = getSignals(makeRow({}));
  assert.strictEqual(hot.signals.find(s => s.key === 'streak').active, true);
  assert.strictEqual(scorching.signals.find(s => s.key === 'streak').active, true);
  assert.strictEqual(cold.signals.find(s => s.key === 'streak').active, false);
  assert.strictEqual(none.signals.find(s => s.key === 'streak').active, false);
});

test('signal: High Confidence fires at pa >= 75 (mid tier) and pa >= 200 (high tier)', () => {
  const low = getSignals(makeRow({ batter: { pa: 40 } }));
  const mid = getSignals(makeRow({ batter: { pa: 75 } }));
  const high = getSignals(makeRow({ batter: { pa: 200 } }));
  assert.strictEqual(low.signals.find(s => s.key === 'conf').active, false);
  assert.strictEqual(mid.signals.find(s => s.key === 'conf').active, true);
  assert.strictEqual(high.signals.find(s => s.key === 'conf').active, true);
});

test('signal: Hot Contact fires on barrel% >= 12 or hard-hit% >= 50, gated by launch angle corridor', () => {
  const barrelHot = getSignals(makeRow({ batter: { ba: 12, hh: 30, la: 28 } }));
  const hhHot = getSignals(makeRow({ batter: { ba: 5, hh: 50, la: 28 } }));
  const cold = getSignals(makeRow({ batter: { ba: 5, hh: 30, la: 28 } }));
  const wrongLaunchAngle = getSignals(makeRow({ batter: { ba: 20, hh: 60, la: 5 } })); // way too flat
  assert.strictEqual(barrelHot.signals.find(s => s.key === 'hotcontact').active, true);
  assert.strictEqual(hhHot.signals.find(s => s.key === 'hotcontact').active, true);
  assert.strictEqual(cold.signals.find(s => s.key === 'hotcontact').active, false);
  assert.strictEqual(wrongLaunchAngle.signals.find(s => s.key === 'hotcontact').active, false,
    'elite contact outside the 20-35 degree launch angle corridor should not count as hot contact');
});

// ── Badge thresholds (CLAUDE.md: Elite=6+, All-Star=5, Value=4) ──────
// Stack six independently-verified-above signals (park, weather, pitcher,
// streak, confidence, hotcontact) and remove them one at a time to land
// exactly on each documented badge boundary. wd:0 (not 180) is the
// "blowing out" fixture here -- see the Wind Out signal test above for why.
function sixSignalRow(overrides = {}) {
  return makeRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 0 },
    pit: { xera: 5.20, hr9: 1.50 },
    streak: { flame: '🔥' },
    batter: { pa: 200, ba: 15, hh: 55, xw: 0.320, la: 28 },
    ...overrides,
  });
}

test('badge: 6 active signals -> Elite Play', () => {
  const result = getSignals(sixSignalRow());
  assert.strictEqual(result.count, 6, `expected 6 active signals, got ${result.count}`);
  assert.strictEqual(result.badge.label, '🏆 Elite Play');
});

test('badge: 5 active signals -> All-Star Play', () => {
  // Drop the streak signal by not seeding STREAK for this player.
  const row = makeRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 0 },
    pit: { xera: 5.20, hr9: 1.50 },
    batter: { pa: 200, ba: 15, hh: 55, xw: 0.320, la: 28 },
  });
  const result = getSignals(row);
  assert.strictEqual(result.count, 5, `expected 5 active signals, got ${result.count}`);
  assert.strictEqual(result.badge.label, '⭐ All-Star Play');
});

test('badge: 4 active signals -> Value Play', () => {
  // Drop streak and confidence (low pa).
  const row = makeRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 0 },
    pit: { xera: 5.20, hr9: 1.50 },
    batter: { pa: 10, ba: 15, hh: 55, xw: 0.320, la: 28 },
  });
  const result = getSignals(row);
  assert.strictEqual(result.count, 4, `expected 4 active signals, got ${result.count}`);
  assert.strictEqual(result.badge.label, '💡 Value Play');
});

test('badge: 3 active signals -> no badge', () => {
  const row = makeRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 0 },
    pit: { xera: 5.20, hr9: 1.50 },
    batter: { pa: 10, ba: 5, hh: 30, xw: 0.310, la: 28 }, // hotcontact off too
  });
  const result = getSignals(row);
  assert.strictEqual(result.count, 3, `expected 3 active signals, got ${result.count}`);
  assert.strictEqual(result.badge, null);
});
