// Scoring and calibration maths for the backtest. Probabilities are 0..1.
'use strict';

const clamp = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
const brier = (ps, ys) => ps.reduce((s, p, i) => s + (p - ys[i]) ** 2, 0) / ps.length;
const logLoss = (ps, ys) => -ps.reduce((s, p, i) => { const c = clamp(p); return s + (ys[i] ? Math.log(c) : Math.log(1 - c)); }, 0) / ps.length;

// Skill = 1 - model / no-skill, where no-skill gives everyone the base rate.
function score(ps, ys) {
  const n = ps.length, base = ys.reduce((a, b) => a + b, 0) / n;
  const bs = brier(ps, ys), bs0 = brier(ps.map(() => base), ys);
  const ll = logLoss(ps, ys), ll0 = logLoss(ps.map(() => base), ys);
  return { n, baseRate: base, meanPred: ps.reduce((a, b) => a + b, 0) / n,
    brier: bs, brierSkill: 1 - bs / bs0, logLoss: ll, logLossSkill: 1 - ll / ll0, auc: auc(ps, ys) };
}

function auc(ps, ys) {
  const idx = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b]);
  let rankSum = 0, pos = 0, i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && ps[idx[j + 1]] === ps[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (ys[idx[k]]) { rankSum += r; pos++; }
    i = j + 1;
  }
  const neg = ps.length - pos;
  return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : null;
}

// Fixed-edge reliability table. edges in probability units.
function bins(ps, ys, edges = [0, .04, .06, .08, .10, .12, .14, .16, .18, .20, .25, 1]) {
  const out = [];
  for (let e = 0; e < edges.length - 1; e++) {
    let n = 0, sp = 0, sy = 0;
    for (let i = 0; i < ps.length; i++) if (ps[i] >= edges[e] && ps[i] < edges[e + 1]) { n++; sp += ps[i]; sy += ys[i]; }
    if (!n) continue;
    const act = sy / n;
    out.push({ lo: edges[e], hi: edges[e + 1], n, pred: sp / n, actual: act, se: Math.sqrt(act * (1 - act) / n) });
  }
  return out;
}

// Isotonic regression (pool adjacent violators), then thinned to a short
// list of knots [x, y] for piecewise-linear interpolation in the app.
function isotonicKnots(ps, ys, maxKnots = 12, minBlock = 400) {
  const idx = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b]);
  const blocks = [];
  for (const i of idx) {
    blocks.push({ n: 1, sx: ps[i], sy: ys[i] });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sy / a.n < b.sy / b.n && a.n >= minBlock) break;
      a.n += b.n; a.sx += b.sx; a.sy += b.sy; blocks.pop();
    }
  }
  // The last block can still be small or violate monotonicity after merging.
  while (blocks.length > 1) {
    const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
    if (b.n >= minBlock && a.sy / a.n < b.sy / b.n) break;
    a.n += b.n; a.sx += b.sx; a.sy += b.sy; blocks.pop();
  }
  let knots = blocks.map(b => [b.sx / b.n, b.sy / b.n, b.n]);
  while (knots.length > maxKnots) {           // merge the lightest neighbour pair
    let best = 0, bestN = Infinity;
    for (let i = 0; i < knots.length - 1; i++) { const n = knots[i][2] + knots[i + 1][2]; if (n < bestN) { bestN = n; best = i; } }
    const [a, b] = [knots[best], knots[best + 1]], n = a[2] + b[2];
    knots.splice(best, 2, [(a[0] * a[2] + b[0] * b[2]) / n, (a[1] * a[2] + b[1] * b[2]) / n, n]);
  }
  return knots.map(k => [+k[0].toFixed(4), +k[1].toFixed(4), k[2]]);
}

// Same interpolation as calibrateHR() in app.html.
function applyKnots(knots, p) {
  if (knots.length < 2) return knots[0][0] > 0 ? p * knots[0][1] / knots[0][0] : knots[0][1];   // too little data for a curve
  if (p <= knots[0][0]) return knots[0][1] * (knots[0][0] > 0 ? p / knots[0][0] : 1);
  for (let i = 1; i < knots.length; i++) {
    if (p <= knots[i][0]) {
      const [x0, y0] = knots[i - 1], [x1, y1] = knots[i];
      return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
    }
  }
  const [xa, ya] = knots[knots.length - 2], [xb, yb] = knots[knots.length - 1];
  return yb + (yb - ya) / (xb - xa) * (p - xb);   // keep the final slope
}

// Average hit rate of each day's top-N picks.
function topN(rows, key, n) {
  const byDay = new Map();
  for (const r of rows) { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); }
  let hits = 0, tot = 0;
  for (const list of byDay.values()) {
    if (list.length < 60) continue;                     // skip tiny slates
    for (const r of list.sort((a, b) => b[key] - a[key]).slice(0, n)) { hits += r.hr; tot++; }
  }
  return { n: tot, hitRate: tot ? hits / tot : null };
}

module.exports = { brier, logLoss, score, auc, bins, isotonicKnots, applyKnots, topN };
