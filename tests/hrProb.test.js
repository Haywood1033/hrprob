// Regression tests for hrProb() — the core HR probability model
// (CLAUDE.md: app.html ~line 812). These exist to catch silent drift in
// the model's math, not to validate specific probability values against
// real-world accuracy (that's what the 54-day backtest/calibration in the
// Accuracy tab is for). If one of these breaks, either the model changed
// on purpose (update the test) or it broke by accident (fix the model).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./lib/loadApp.js');

const app = loadApp();

// hrProb(batter, park, weather, pitcher, battingOrder) — all five args are
// plain objects/numbers, no global state required, which is what makes it
// cleanly unit-testable on its own.
function hrProb(b, park, wx, pit, order) {
  return app.run(
    `hrProb(${JSON.stringify(b)}, ${JSON.stringify(park)}, ${JSON.stringify(wx)}, ${JSON.stringify(pit)}, ${JSON.stringify(order)})`
  );
}

const LEAGUE_PARK = { f: 1.0, roof: 'open' };
const LEAGUE_WX = {};
const LEAGUE_PIT = {};

test('hrProb: result is always a finite number within the documented [floor, 32] bounds', () => {
  const cases = [
    [{ pa: 0 }, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5],
    [{ pa: 500, ba: 25, ev: 96, xw: 0.450, iso: 0.350, hh: 55 }, { f: 1.38 }, { ws: 20, wd: 180 }, { xera: 6.5, hr9: 2.5 }, 3],
    [{ pa: 500, ba: 0, ev: 75, xw: 0.150, iso: 0.050, hh: 10 }, { f: 0.85 }, {}, { xera: 2.0, hr9: 0.4 }, 9],
  ];
  for (const args of cases) {
    const p = hrProb(...args);
    assert.ok(Number.isFinite(p), `expected finite number, got ${p}`);
    assert.ok(p >= 0.5, `expected >= 0.5 floor, got ${p}`);
    assert.ok(p <= 32, `expected <= 32 ceiling, got ${p}`);
  }
});

test('hrProb: at pa=0, the regressed base rate ignores raw batter stats', () => {
  // Note: ba/ev also feed a separate "smart floor" (see the next test)
  // that is NOT gated by pa — so these fixtures deliberately keep ba/ev
  // within the same floor tier (both hit the 0.5 floor) to isolate the
  // regression itself from that floor mechanism.
  const elite = { pa: 0, ba: 3, ev: 85, xw: 0.999, iso: 0.999, hh: 99 };
  const replacement = { pa: 0, ba: 0, ev: 60, xw: 0.100, iso: 0.020, hh: 5 };
  const pElite = hrProb(elite, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  const pReplacement = hrProb(replacement, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  assert.strictEqual(pElite, pReplacement,
    'with 0 PA, the Bayesian regression should fully discount raw stats regardless of how extreme they are');
});

test('hrProb: the smart floor gives real elite raw contact quality a higher minimum, even at pa=0', () => {
  // "Smart floor" (app.html ~line 1072) reads b.ba/b.ev directly — deliberately
  // not regressed — so a batter who is elite on small-sample-but-real contact
  // data can't be pushed all the way down to the pure league-average estimate.
  const eliteContact = { pa: 0, ba: 15, ev: 95 }; // brlFloor>=12 & evFloor>=92 -> 7.0 floor
  const noContactData = { pa: 0 };                 // brlFloor=0, evFloor=88 default -> 3.5 floor
  const pElite = hrProb(eliteContact, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  const pNone = hrProb(noContactData, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  assert.ok(pElite >= 7.0, `elite raw contact quality should hit the 7.0 floor, got ${pElite}`);
  assert.ok(pElite > pNone, `elite raw contact quality should score above a batter with no contact data (${pNone} -> ${pElite})`);
});

test('hrProb: Bayesian regression pulls low-PA batters toward league average more than high-PA batters', () => {
  const hotStats = { ba: 20, ev: 95, xw: 0.400, iso: 0.300, hh: 50 };
  const leagueAvgOnly = hrProb({ pa: 0 }, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  const lowPA  = hrProb({ pa: 20,  ...hotStats }, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  const highPA = hrProb({ pa: 500, ...hotStats }, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
  assert.ok(lowPA > leagueAvgOnly, 'a hot batter, even at low PA, should score above league average');
  assert.ok(highPA > lowPA,
    'the same hot stats should count for more at 500 PA than at 20 PA (less regression toward the mean)');
});

for (const [label, key] of [['barrel%', 'ba'], ['exit velo', 'ev'], ['xwOBA', 'xw'], ['ISO', 'iso'], ['hard-hit%', 'hh']]) {
  test(`hrProb: higher ${label} (holding everything else fixed) increases probability`, () => {
    const base = { pa: 400, ba: 8, ev: 88, xw: 0.310, iso: 0.150, hh: 37 };
    const boosted = { ...base, [key]: base[key] * 1.8 + 5 };
    const pBase = hrProb(base, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
    const pBoosted = hrProb(boosted, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 5);
    assert.ok(pBoosted > pBase, `boosting ${label} from ${base[key]} to ${boosted[key]} should raise probability (${pBase} -> ${pBoosted})`);
  });
}

test('hrProb: a more hitter-friendly park factor increases probability', () => {
  const batter = { pa: 400, ba: 10, ev: 90, xw: 0.320, iso: 0.170, hh: 40 };
  const pCoors = hrProb(batter, { f: 1.38, roof: 'open' }, LEAGUE_WX, LEAGUE_PIT, 5);
  const pPitcherPark = hrProb(batter, { f: 0.91, roof: 'open' }, LEAGUE_WX, LEAGUE_PIT, 5);
  assert.ok(pCoors > pPitcherPark, `f=1.38 park should score higher than f=0.91 park (${pPitcherPark} -> ${pCoors})`);
});

test('hrProb: wind blowing out raises probability, wind blowing in lowers it, vs. no-wind baseline', () => {
  const batter = { pa: 400, ba: 10, ev: 90, xw: 0.320, iso: 0.170, hh: 40 };
  const park = { f: 1.0, roof: 'open', orient: 180 };
  const noWind = hrProb(batter, park, {}, LEAGUE_PIT, 5);
  // wx.wd is meteorological wind direction (source, not travel direction).
  // orient=180 is the park's home-plate-to-center-field bearing. Wind
  // sourced from the SAME bearing as center field (wd=180, diff=0) is
  // blowing FROM center field TOWARD home plate -- i.e. blowing IN. Wind
  // sourced from the opposite bearing (wd=0, diff=180, from behind home
  // plate) carries fly balls OUT toward center field.
  const windOut = hrProb(batter, park, { ws: 15, wd: 0 }, LEAGUE_PIT, 5);   // diff=180 -> blowing out
  const windIn = hrProb(batter, park, { ws: 15, wd: 180 }, LEAGUE_PIT, 5);  // diff=0 -> blowing in
  assert.ok(windOut > noWind, `wind out should raise probability above no-wind baseline (${noWind} -> ${windOut})`);
  assert.ok(windIn < noWind, `wind in should lower probability below no-wind baseline (${noWind} -> ${windIn})`);
});

test('hrProb: wind is ignored under a dome or retractable roof', () => {
  const batter = { pa: 400, ba: 10, ev: 90, xw: 0.320, iso: 0.170, hh: 40 };
  const domePark = { f: 1.0, roof: 'dome', orient: 180 };
  const pNoWind = hrProb(batter, domePark, {}, LEAGUE_PIT, 5);
  const pWithWind = hrProb(batter, domePark, { ws: 20, wd: 180 }, LEAGUE_PIT, 5);
  assert.strictEqual(pNoWind, pWithWind, 'wind should have zero effect on probability when the roof is closed');
});

test('hrProb: a worse pitcher matchup (higher xERA/HR9) raises probability', () => {
  const batter = { pa: 400, ba: 10, ev: 90, xw: 0.320, iso: 0.170, hh: 40 };
  const ace = { xera: 2.50, hr9: 0.60, whiff: 30, hh: 32 };
  const bad = { xera: 6.00, hr9: 2.20, whiff: 15, hh: 45 };
  const pAce = hrProb(batter, LEAGUE_PARK, LEAGUE_WX, ace, 5);
  const pBad = hrProb(batter, LEAGUE_PARK, LEAGUE_WX, bad, 5);
  assert.ok(pBad > pAce, `facing a bad pitcher should score higher than facing an ace (${pAce} -> ${pBad})`);
});

test('hrProb: heart-of-the-order batting position scores higher than the bottom of the order', () => {
  const batter = { pa: 400, ba: 10, ev: 90, xw: 0.320, iso: 0.170, hh: 40 };
  const cleanup = hrProb(batter, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 4);
  const bottom  = hrProb(batter, LEAGUE_PARK, LEAGUE_WX, LEAGUE_PIT, 9);
  assert.ok(cleanup > bottom, `batting 4th should score higher than batting 9th, all else equal (${bottom} -> ${cleanup})`);
});
