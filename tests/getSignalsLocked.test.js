// Regression tests for getSignalsLocked() (CLAUDE.md: app.html ~line 2872).
// The signal lock exists so a player's badge/count can't shift mid-game —
// but the icon row it returns used to recompute live signals via
// getSignals(r) on every call, while count/badge stayed pinned to the
// locked snapshot. That let the icon row show more (or fewer) signals lit
// than the count/badge reflected, e.g. wind turning on or a hot streak
// building after the lock was built — a player could look "flagged
// enough" for Signal Plays while the locked count said otherwise. The fix
// makes the icon row read from the same locked snapshot as count/badge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/loadApp.js');

const app = loadApp();
let seq = 0;
function uniqueName(label) { return `${label} ${++seq}`; }

function resetLockState() {
  app.run(`for (const k of Object.keys(SIGNAL_LOCK)) delete SIGNAL_LOCK[k]; _signalLockDate = '2026-09-19';`);
}

// Seeds a row whose LIVE getSignals() would light up several signals
// (park, weather, pitcher, streak, confidence all active), so any test
// case can prove the locked path ignores this live-favorable state.
function makeHotLiveRow({ team, name } = {}) {
  const t = team || uniqueName('Team');
  const n = name || uniqueName('Player');
  app.run(`PARKS[${JSON.stringify(t)}] = {f: 1.20, roof: 'open', orient: 180}`);
  app.run(`WX[${JSON.stringify(t)}] = {ws: 15, wd: 180}`);
  app.run(`BATTER[${JSON.stringify(n)}] = {pa: 200, xw: 0.320, ba: 15, hh: 55, la: 28}`);
  app.run(`STREAK[${JSON.stringify(n)}] = {flame: '🔥🔥'}`);
  const pit = { xera: 5.50, hr9: 1.60 };
  return { name: n, team: t, pit, hrp: 12 };
}

function getSignalsLocked(row) {
  return app.run(`getSignalsLocked(${JSON.stringify(row)})`);
}

// .map() on a value from the vm sandbox produces a new array built with the
// sandbox realm's Array constructor, which still fails deepStrictEqual
// against a plain local array (different [[Prototype]]) even when every
// element matches. Array.from(), called as a static on the OUTER Array,
// rehomes the result into this realm so plain deepStrictEqual works.
function activeStates(signals) { return Array.from(signals, s => s.active); }
function icons(signals) { return Array.from(signals, s => s.icon); }

test('getSignalsLocked: falls back to live getSignals() when no lock entry exists', () => {
  resetLockState();
  const row = makeHotLiveRow();
  const result = getSignalsLocked(row);
  // No SIGNAL_LOCK entry for this player -> should match a fresh live call.
  const live = app.run(`getSignals(${JSON.stringify(row)})`);
  assert.strictEqual(result.count, live.count);
  assert.deepStrictEqual(activeStates(result.signals), activeStates(live.signals));
});

test('getSignalsLocked: icon row reflects the LOCKED snapshot, not a fresh live recomputation', () => {
  resetLockState();
  // Row is seeded so live getSignals() would light up park/weather/pitcher/
  // streak/confidence (5 signals) -- but the lock was built earlier when
  // only 2 were active. The icons must show the locked 2, not the live 5.
  const row = makeHotLiveRow();
  const lockedBooleans = [false, false, false, true, false, false, false, true]; // streak + hotcontact only
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: ${JSON.stringify(lockedBooleans)}, count: 2, badge: null, ci: {}, hrp: 8 }`);

  // Sanity check: live signals for this row really would differ from the lock.
  const live = app.run(`getSignals(${JSON.stringify(row)})`);
  assert.ok(live.count > 2, 'fixture should produce a live count higher than the locked count, to prove they diverge');

  const result = getSignalsLocked(row);
  assert.strictEqual(result.count, 2, 'count must come from the lock, not live');
  assert.deepStrictEqual(activeStates(result.signals), lockedBooleans,
    'icon active-states must match the locked snapshot, not the live recomputation');
});

test('getSignalsLocked: badge comes from the locked snapshot even when live signals would qualify for a higher badge', () => {
  resetLockState();
  const row = makeHotLiveRow();
  const lockedBadge = { label: '💡 Value Play', color: 'var(--purple)', bg: '', bd: '' };
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: [true,false,false,true,false,false,false,true], count: 4, badge: ${JSON.stringify(lockedBadge)}, ci: {}, hrp: 10 }`);
  const result = getSignalsLocked(row);
  assert.strictEqual(result.badge.label, '💡 Value Play');
  assert.strictEqual(result.count, 4);
});

test('getSignalsLocked: icon order/keys line up with the documented 8-signal order', () => {
  resetLockState();
  const row = makeHotLiveRow();
  const lockedBooleans = [true, false, true, false, true, false, true, false];
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: ${JSON.stringify(lockedBooleans)}, count: 4, badge: null, ci: {}, hrp: 10 }`);
  const result = getSignalsLocked(row);
  const expectedIcons = ['🏟','💨','🎯','🔥','🔒','🏏','⚔️','💥'];
  assert.deepStrictEqual(icons(result.signals), expectedIcons);
  assert.deepStrictEqual(activeStates(result.signals), lockedBooleans);
});
