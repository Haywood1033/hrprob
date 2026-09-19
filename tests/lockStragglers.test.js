// Regression tests for lockStragglers() (CLAUDE.md: app.html, defined right
// after lockSignals() ~line 2848). Fixes the bug where a player who wasn't
// in allRows yet when the main signal lock was built (e.g. a late lineup
// swap posted after pre-game lock) would never receive a SIGNAL_LOCK entry
// and would stay "live" forever, letting in-game stats (like a HR they just
// hit) retroactively land them on the Sharp Plays tab. lockStragglers()
// is called every rebuild() and locks any pre-game player still missing
// from SIGNAL_LOCK, while leaving Live/Final games alone since locking
// those after the fact would defeat the whole point of a pre-game lock.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/loadApp.js');

const app = loadApp();
let seq = 0;
function uniqueName(label) { return `${label} ${++seq}`; }

// Resets the shared global state lockStragglers() reads/writes so tests
// in this file don't leak into each other (SIGNAL_LOCK is a `const` object
// in app.html, so it's cleared in place rather than reassigned).
function resetLockState({ signalLockDate = '2026-09-19' } = {}) {
  app.run(`
    for (const k of Object.keys(SIGNAL_LOCK)) delete SIGNAL_LOCK[k];
    allRows = [];
    _liveGames = {};
    _signalLockDate = ${JSON.stringify(signalLockDate)};
  `);
}

// Seeds PARKS/WX/BATTER so getSignals(r) has something to work with, adds
// the row to allRows, and returns the row. gamePk defaults to a fresh
// unique value so tests don't collide on _liveGames lookups.
function addRow({ team, park = {}, wx = {}, batter = {}, pit = {}, hrp = 10, gamePk } = {}) {
  const t = team || uniqueName('Team');
  const name = uniqueName('Player');
  const pk = gamePk ?? ++seq;
  const parkFixture = { f: 1.0, roof: 'open', orient: 180, ...park };
  const wxFixture = { ws: 0, wd: 180, ...wx };
  const batterFixture = { pa: 10, xw: 0.310, ...batter };
  app.run(`PARKS[${JSON.stringify(t)}] = ${JSON.stringify(parkFixture)}`);
  app.run(`WX[${JSON.stringify(t)}] = ${JSON.stringify(wxFixture)}`);
  app.run(`BATTER[${JSON.stringify(name)}] = ${JSON.stringify(batterFixture)}`);
  const row = { name, team: t, pit, hrp, gamePk: pk };
  app.run(`allRows.push(${JSON.stringify(row)})`);
  return row;
}

function runLockStragglers() { app.run('lockStragglers()'); }
function getSignalLock() { return app.run('SIGNAL_LOCK'); }
function getLiveGames() { return app.run('_liveGames'); }

test('lockStragglers: no-ops if the main lock has not been built yet (_signalLockDate unset)', () => {
  resetLockState({ signalLockDate: null });
  addRow({});
  runLockStragglers();
  // getSignalLock() returns an object from the vm sandbox's realm, so
  // deepStrictEqual against a literal {} fails on prototype identity even
  // when empty — compare key count instead.
  assert.strictEqual(Object.keys(getSignalLock()).length, 0, 'should not lock anything before the main lock exists');
});

test('lockStragglers: no-ops if SIGNAL_LOCK is still empty (main lock not built yet)', () => {
  resetLockState({ signalLockDate: '2026-09-19' });
  addRow({});
  runLockStragglers();
  assert.strictEqual(Object.keys(getSignalLock()).length, 0, 'an empty SIGNAL_LOCK means the main lock has not run yet, so stragglers should not run either');
});

test('lockStragglers: locks a straggler whose game has not started yet', () => {
  resetLockState();
  // Seed one existing lock entry so SIGNAL_LOCK is non-empty (main lock has run).
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  // A straggler added to allRows after the main lock ran, game not live yet.
  const straggler = addRow({ hrp: 15 });
  runLockStragglers();
  const lock = getSignalLock();
  assert.ok(lock[straggler.name], 'straggler should now have a SIGNAL_LOCK entry');
  assert.strictEqual(lock[straggler.name].hrp, 15);
});

test('lockStragglers: does not lock a straggler whose game is Live', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const straggler = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(straggler.gamePk))}] = { status: 'Live' }`);
  runLockStragglers();
  const lock = getSignalLock();
  assert.strictEqual(lock[straggler.name], undefined, 'a player whose game already went live should be left unlocked (per known accepted limitation)');
});

test('lockStragglers: does not lock a straggler whose game is Final', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const straggler = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(straggler.gamePk))}] = { status: 'Final' }`);
  runLockStragglers();
  const lock = getSignalLock();
  assert.strictEqual(lock[straggler.name], undefined, 'a player whose game already ended should be left unlocked');
});

test('lockStragglers: does not overwrite an already-locked player', () => {
  resetLockState();
  const row = addRow({ hrp: 12 });
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: ['sentinel'], count: 99, badge: { label: 'sentinel' }, ci: {}, hrp: 999 }`);
  runLockStragglers();
  const lock = getSignalLock();
  assert.strictEqual(lock[row.name].hrp, 999, 'existing lock entry must be left untouched, not recomputed from live data');
  assert.strictEqual(lock[row.name].count, 99);
});

test('lockStragglers: locks multiple pending stragglers in one pass, skipping only live/final ones', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const pending1 = addRow({});
  const pending2 = addRow({});
  const live = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(live.gamePk))}] = { status: 'Live' }`);
  runLockStragglers();
  const lock = getSignalLock();
  assert.ok(lock[pending1.name], 'pending1 should be locked');
  assert.ok(lock[pending2.name], 'pending2 should be locked');
  assert.strictEqual(lock[live.name], undefined, 'live game player should stay unlocked');
});
