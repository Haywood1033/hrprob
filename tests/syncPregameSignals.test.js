// Regression tests for syncPregameSignals() (CLAUDE.md: app.html, defined
// right after lockSignals() ~line 2848; renamed/broadened from the earlier
// lockStragglers()). Called every rebuild(), it keeps SIGNAL_LOCK in sync
// for any player whose game hasn't gone Live/Final yet, covering two gaps
// in the one-time lockSignals() pass:
//   1. Missing entirely — a late lineup swap wasn't in allRows yet when the
//      main lock was built, so it never got a SIGNAL_LOCK entry and would
//      stay "live" forever (in-game stats, like a HR just hit, could
//      retroactively land it on the Sharp Plays tab).
//   2. Present but stale — a player WAS locked, but an upstream data
//      source (e.g. STREAK, fetched once per page load) hadn't caught up
//      yet, so the locked signals reflect an incomplete pre-game picture
//      even though later live data shows the corrected numbers.
// Both are safe to fix pre-game since nothing about the player's own game
// action could be inflating the numbers yet. Once a game goes Live/Final,
// its entry is left exactly as locked, whether or not one existed yet.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/loadApp.js');

const app = loadApp();
let seq = 0;
function uniqueName(label) { return `${label} ${++seq}`; }

// Resets the shared global state syncPregameSignals() reads/writes so tests
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

function runSync() { app.run('syncPregameSignals()'); }
function getSignalLock() { return app.run('SIGNAL_LOCK'); }

test('syncPregameSignals: no-ops if the main lock has not been built yet (_signalLockDate unset)', () => {
  resetLockState({ signalLockDate: null });
  addRow({});
  runSync();
  // getSignalLock() returns an object from the vm sandbox's realm, so
  // deepStrictEqual against a literal {} fails on prototype identity even
  // when empty — compare key count instead.
  assert.strictEqual(Object.keys(getSignalLock()).length, 0, 'should not touch anything before the main lock exists');
});

test('syncPregameSignals: no-ops if SIGNAL_LOCK is still empty (main lock not built yet)', () => {
  resetLockState({ signalLockDate: '2026-09-19' });
  addRow({});
  runSync();
  assert.strictEqual(Object.keys(getSignalLock()).length, 0, 'an empty SIGNAL_LOCK means the main lock has not run yet, so this should not run either');
});

test('syncPregameSignals: locks a straggler whose game has not started yet', () => {
  resetLockState();
  // Seed one existing lock entry so SIGNAL_LOCK is non-empty (main lock has run).
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  // A straggler added to allRows after the main lock ran, game not live yet.
  const straggler = addRow({ hrp: 15 });
  runSync();
  const lock = getSignalLock();
  assert.ok(lock[straggler.name], 'straggler should now have a SIGNAL_LOCK entry');
  assert.strictEqual(lock[straggler.name].hrp, 15);
});

test('syncPregameSignals: does not lock a straggler whose game is Live', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const straggler = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(straggler.gamePk))}] = { status: 'Live' }`);
  runSync();
  const lock = getSignalLock();
  assert.strictEqual(lock[straggler.name], undefined, 'a player whose game already went live should be left unlocked (per known accepted limitation)');
});

test('syncPregameSignals: does not lock a straggler whose game is Final', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const straggler = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(straggler.gamePk))}] = { status: 'Final' }`);
  runSync();
  const lock = getSignalLock();
  assert.strictEqual(lock[straggler.name], undefined, 'a player whose game already ended should be left unlocked');
});

test('syncPregameSignals: refreshes an already-locked pre-game player whose computed signals changed', () => {
  resetLockState();
  // Row seeded to produce several active signals when computed fresh —
  // simulates a streak/park/etc. data source catching up after an earlier,
  // incomplete lock was built and saved.
  const row = addRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 180 },
    pit: { xera: 5.20, hr9: 1.50 },
    batter: { pa: 200, ba: 15, hh: 55, xw: 0.320, la: 28 },
    hrp: 12,
  });
  app.run(`STREAK[${JSON.stringify(row.name)}] = { flame: '🔥🔥' }`);
  // Stale lock from earlier in the day: nothing active, count 0.
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: [false,false,false,false,false,false,false,false], count: 0, badge: null, ci: {}, hrp: 5 }`);

  // Sanity check the fixture really would compute differently live.
  const live = app.run(`getSignals(${JSON.stringify(row)})`);
  assert.ok(live.count > 0, 'fixture should produce active signals live, to prove it differs from the stale lock');

  runSync();
  const lock = getSignalLock();
  assert.strictEqual(lock[row.name].count, live.count, 'stale pre-game lock should be refreshed to the freshly computed count');
  assert.strictEqual(lock[row.name].hrp, 12, 'hrp should also refresh to the current row value');
});

test('syncPregameSignals: does NOT touch an existing lock entry once the game is Live, even if live signals differ', () => {
  resetLockState();
  const row = addRow({
    park: { f: 1.10 },
    wx: { ws: 10, wd: 180 },
    pit: { xera: 5.20, hr9: 1.50 },
    batter: { pa: 200, ba: 15, hh: 55, xw: 0.320, la: 28 },
    hrp: 12,
  });
  app.run(`STREAK[${JSON.stringify(row.name)}] = { flame: '🔥🔥' }`);
  app.run(`SIGNAL_LOCK[${JSON.stringify(row.name)}] = { signals: [false,false,false,false,false,false,false,false], count: 0, badge: null, ci: {}, hrp: 5 }`);
  app.run(`_liveGames[${JSON.stringify(String(row.gamePk))}] = { status: 'Live' }`);

  runSync();
  const lock = getSignalLock();
  assert.strictEqual(lock[row.name].count, 0, 'a Live game player must keep their frozen pre-game snapshot, however live signals compute now');
  assert.strictEqual(lock[row.name].hrp, 5);
});

test('syncPregameSignals: locks multiple pending stragglers in one pass, skipping only live/final ones', () => {
  resetLockState();
  const locked = addRow({});
  app.run(`SIGNAL_LOCK[${JSON.stringify(locked.name)}] = { signals: [], count: 0, badge: null, ci: {}, hrp: ${locked.hrp} }`);
  const pending1 = addRow({});
  const pending2 = addRow({});
  const live = addRow({});
  app.run(`_liveGames[${JSON.stringify(String(live.gamePk))}] = { status: 'Live' }`);
  runSync();
  const lock = getSignalLock();
  assert.ok(lock[pending1.name], 'pending1 should be locked');
  assert.ok(lock[pending2.name], 'pending2 should be locked');
  assert.strictEqual(lock[live.name], undefined, 'live game player should stay unlocked');
});
