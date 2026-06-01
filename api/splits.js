// api/splits.js — real platoon splits for top batters + starting pitchers
// Returns batter vsRHP/vsLHP and pitcher vsLHB/vsRHB splits
// Called once after Statcast loads with top 40 player names + today's pitchers

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let cache = { data: null, timestamp: null };

async function searchPlayer(name) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1&active=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const p = d.people?.[0];
  if (!p) return null;
  return { id: p.id, batSide: p.batSide?.code || 'R', pitHand: p.pitchHand?.code || 'R' };
}

async function getBatterSplits(playerId) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=hitting&sportId=1&sitCodes=vr,vl`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const splits = d.stats?.[0]?.splits || [];
  const result = { vsRHP: null, vsLHP: null };

  for (const s of splits) {
    const code = s.split?.code;
    const stat = s.stat || {};
    const ab = stat.atBats || 0;
    if (ab < 10) continue;

    const h   = stat.hits        || 0;
    const hr  = stat.homeRuns    || 0;
    const tb  = stat.totalBases  || 0;
    const bb  = stat.baseOnBalls || 0;
    const pa  = stat.plateAppearances || (ab + bb);

    const avg  = ab > 0 ? +(h/ab).toFixed(3)     : 0;
    const slg  = ab > 0 ? +(tb/ab).toFixed(3)     : 0;
    const obp  = pa > 0 ? +((h+bb)/pa).toFixed(3) : 0;
    const iso  = +(slg - avg).toFixed(3);
    const hrpa = pa > 0 ? +(hr/pa).toFixed(4)      : 0;

    const entry = { ab, avg, slg, obp, iso, hr, hrpa };
    if (code === 'vr') result.vsRHP = entry;
    if (code === 'vl') result.vsLHP = entry;
  }

  if (!result.vsRHP && !result.vsLHP) return null;
  return result;
}

async function getPitcherSplits(playerId) {
  // Get pitcher's stats vs LHB and vs RHB
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=pitching&sportId=1&sitCodes=vr,vl`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const splits = d.stats?.[0]?.splits || [];
  const result = { vsLHB: null, vsRHB: null };

  for (const s of splits) {
    const code = s.split?.code;
    const stat = s.stat || {};
    const ab  = stat.atBats  || 0;
    const bf  = stat.battersFaced || ab;
    if (bf < 15) continue; // need min sample

    const h   = stat.hits        || 0;
    const hr  = stat.homeRuns    || 0;
    const bb  = stat.baseOnBalls || 0;
    const so  = stat.strikeOuts  || 0;
    const ip  = parseFloat(stat.inningsPitched || '0') || 0;
    const er  = stat.earnedRuns  || 0;

    const era  = ip > 0  ? +(er / ip * 9).toFixed(2)   : 4.50;
    const whip = ip > 0  ? +((h + bb) / ip).toFixed(2) : 1.30;
    const kp9  = ip > 0  ? +(so / ip * 9).toFixed(1)   : 8.0;
    const hr9  = ip > 0  ? +(hr / ip * 9).toFixed(2)   : 1.20;
    const babip = (ab - so - hr) > 0
      ? +((h - hr) / (ab - so - hr)).toFixed(3) : 0.300;

    // Estimate xERA from component stats (FIP proxy)
    // FIP = (13*HR + 3*BB - 2*K) / IP + 3.10 (constant)
    const fip = ip > 0
      ? +((13*hr + 3*bb - 2*so) / ip + 3.10).toFixed(2)
      : 4.50;

    const entry = { bf, ab, era, fip, whip, kp9, hr9, babip, hr, bb, so };

    // vr = vs right-handed batters, vl = vs left-handed batters
    if (code === 'vr') result.vsRHB = entry;
    if (code === 'vl') result.vsLHB = entry;
  }

  if (!result.vsLHB && !result.vsRHB) return null;
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  let names = [], pitchers = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    names    = body.names    || [];
    pitchers = body.pitchers || []; // array of pitcher names
  } catch(e) { return res.status(400).json({ error: 'Invalid body' }); }

  if (!names.length) return res.status(400).json({ error: 'No names' });

  const batterSplits  = {};
  const pitcherSplits = {};
  const start = Date.now();

  // ── BATTER SPLITS ────────────────────────────────────────────
  for (let i = 0; i < Math.min(names.length, 60); i += 5) {
    const batch = names.slice(i, i + 5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const person = await searchPlayer(name);
        if (!person) return;
        const splits = await getBatterSplits(person.id);
        if (splits) {
          batterSplits[name] = { ...splits, batSide: person.batSide };
        } else {
          batterSplits[name] = { batSide: person.batSide, vsRHP: null, vsLHP: null };
        }
      } catch(e) { console.warn(`Batter splits ${name}:`, e.message); }
    }));
  }

  // ── PITCHER SPLITS ───────────────────────────────────────────
  const uniquePitchers = [...new Set(pitchers)].filter(Boolean);
  for (let i = 0; i < uniquePitchers.length; i += 5) {
    const batch = uniquePitchers.slice(i, i + 5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const person = await searchPlayer(name);
        if (!person) return;
        const splits = await getPitcherSplits(person.id);
        if (splits) {
          pitcherSplits[name] = { ...splits, pitHand: person.pitHand };
        } else {
          pitcherSplits[name] = { pitHand: person.pitHand, vsLHB: null, vsRHB: null };
        }
      } catch(e) { console.warn(`Pitcher splits ${name}:`, e.message); }
    }));
  }

  const withBoth = Object.values(batterSplits).filter(s => s.vsRHP && s.vsLHP).length;
  const pitWithBoth = Object.values(pitcherSplits).filter(s => s.vsLHB && s.vsRHB).length;
  console.log(`Splits: ${Object.keys(batterSplits).length} batters (${withBoth} both sides), ${Object.keys(pitcherSplits).length} pitchers (${pitWithBoth} both sides), ${Date.now()-start}ms`);

  cache = { data: { splits: batterSplits, pitcherSplits }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.status(200).json({ splits: batterSplits, pitcherSplits, elapsed: Date.now() - start });
};
