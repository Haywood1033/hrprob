// Grading rules for prediction results (api/history.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// api/history.js opens a pg Pool at load; stub the driver so the pure
// helpers can be tested without the dependency or a database.
const realLoad = Module._load;
Module._load = (req, ...rest) => req === 'pg' ? { Pool: class { connect() { throw new Error('no db in tests'); } } } : realLoad(req, ...rest);
const { normName, gameState, gradeRow } = require('../api/history.js');
Module._load = realLoad;

test('normName: accents, punctuation and suffixes do not break a match', () => {
  assert.equal(normName('Ronald Acuña Jr.'), normName('Ronald Acuna Jr'));
  assert.equal(normName('J.D. Martinez'), normName('JD Martinez'));
  assert.equal(normName("Travis d'Arnaud"), normName('Travis dArnaud'));
  assert.notEqual(normName('Will Smith'), normName('Wil Smits'));
});

test('gradeRow: hit, miss, and void for a player who never batted', () => {
  const played = new Map([[normName('Aaron Judge'), { hr: 1, pa: 4 }], [normName('José Ramírez'), { hr: 0, pa: 5 }]]);
  assert.deepEqual(gradeRow({ name: 'Aaron Judge', hrp: 18 }, played), { name: 'Aaron Judge', hrp: 18, hit: 1, pa: 4 });
  assert.equal(gradeRow({ name: 'Jose Ramirez' }, played).hit, 0);
  const scratched = gradeRow({ name: 'Mike Trout', hit: 0 }, played);
  assert.equal(scratched.hit, null);
  assert.equal(scratched.dnp, true);
});

test('gradeRow: regrading clears an old did-not-bat flag', () => {
  const played = new Map([[normName('Mike Trout'), { hr: 0, pa: 3 }]]);
  const r = gradeRow({ name: 'Mike Trout', hit: null, dnp: true }, played);
  assert.equal(r.hit, 0);
  assert.equal('dnp' in r, false);
});

test('gameState: only finished games are graded', () => {
  assert.equal(gameState({ status: { codedGameState: 'F', detailedState: 'Final' } }), 'final');
  assert.equal(gameState({ status: { abstractGameState: 'Final', detailedState: 'Postponed' } }), 'off');
  assert.equal(gameState({ status: { codedGameState: 'I', detailedState: 'In Progress' } }), 'pending');
  assert.equal(gameState({ status: { codedGameState: 'S', detailedState: 'Suspended: Rain' } }), 'off');
});
