// api/splits.js — real platoon splits for top batters
// Returns vs_rhp and vs_lhp ISO/SLG/wOBA for each player
// Called once after Statcast loads with top 40 player names

const CACHE_TTL = 60 * 60 * 1000; // 1 hour — splits don't change intraday
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
  return { id: p.id, batSide: p.batSide?.code || 'R' };
}

async function getPlatoonSplits(playerId) {  // playerId is just the numeric ID
  // MLB Stats API statSplits — returns vs RHP and vs LHP splits for current season
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
    const ab  = stat.atBats || 0;
    if (ab < 10) continue; // need min sample

    const h   = stat.hits        || 0;
    const hr  = stat.homeRuns    || 0;
    const tb  = stat.totalBases  || 0;
    const bb  = stat.baseOnBalls || 0;
    const pa  = stat.plateAppearances || (ab + bb);

    const avg  = ab > 0 ? +(h/ab).toFixed(3)      : 0;
    const slg  = ab > 0 ? +(tb/ab).toFixed(3)      : 0;
    const obp  = pa > 0 ? +((h+bb)/pa).toFixed(3)  : 0;
    const iso  = +(slg - avg).toFixed(3);
    const hrpa = pa > 0 ? +(hr/pa).toFixed(4)       : 0;

    const entry = { ab, avg, slg, obp, iso, hr, hrpa };

    if (code === 'vr') result.vsRHP = entry;
    if (code === 'vl') result.vsLHP = entry;
  }

  // Only return if we have at least one split
  if (!result.vsRHP && !result.vsLHP) return null;
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Return cache if fresh
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  let names = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    names = body.names || [];
  } catch(e) { return res.status(400).json({ error: 'Invalid body' }); }

  if (!names.length) return res.status(400).json({ error: 'No names' });

  const results = {};
  const start = Date.now();

  // Process in batches of 5
  for (let i = 0; i < Math.min(names.length, 60); i += 5) {
    const batch = names.slice(i, i + 5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const person = await searchPlayer(name);
        if (!person) return;
        const splits = await getPlatoonSplits(person.id);
        if (splits) {
          results[name] = { ...splits, batSide: person.batSide };
        } else {
          // Still return batSide even if no split data
          results[name] = { batSide: person.batSide, vsRHP: null, vsLHP: null };
        }
      } catch(e) {
        console.warn(`Splits ${name}:`, e.message);
      }
    }));
  }

  const withBoth = Object.values(results).filter(s => s.vsRHP && s.vsLHP).length;
  console.log(`Splits: ${Object.keys(results).length}/${names.length} players, ${withBoth} with both sides, ${Date.now()-start}ms`);

  cache = { data: { splits: results }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.status(200).json({ splits: results, elapsed: Date.now() - start });
};
