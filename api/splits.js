// api/splits.js — real platoon splits for top batters + starting pitchers
// Returns batter vsRHP/vsLHP, pitcher vsLHB/vsRHB, and career park splits
// Called once after Statcast loads with player names + today's pitchers + venue info

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
let cache = { data: null, timestamp: null };

// MLB venue IDs — stable infrastructure IDs that don't change
const VENUE_IDS = {
  'Angels':        1,     // Angel Stadium
  'Diamondbacks':  15,    // Chase Field
  'Orioles':       2,     // Camden Yards
  'Red Sox':       3,     // Fenway Park
  'Cubs':          17,    // Wrigley Field
  'Reds':          2602,  // Great American Ball Park
  'Guardians':     5,     // Progressive Field
  'Rockies':       19,    // Coors Field
  'Tigers':        2394,  // Comerica Park
  'Astros':        2392,  // Minute Maid Park
  'Royals':        7,     // Kauffman Stadium
  'Dodgers':       22,    // Dodger Stadium
  'Marlins':       4169,  // loanDepot park
  'Brewers':       32,    // American Family Field
  'Twins':         3312,  // Target Field
  'Mets':          3289,  // Citi Field
  'Yankees':       3313,  // Yankee Stadium
  'Athletics':     10,    // Oakland Coliseum / Sutter Health
  'Phillies':      2681,  // Citizens Bank Park
  'Pirates':       31,    // PNC Park
  'Padres':        2680,  // Petco Park
  'Giants':        2395,  // Oracle Park
  'Mariners':      680,   // T-Mobile Park
  'Cardinals':     2889,  // Busch Stadium
  'Rays':          12,    // Tropicana Field
  'Rangers':       5325,  // Globe Life Field
  'Blue Jays':     14,    // Rogers Centre
  'Nationals':     3309,  // Nationals Park
  'White Sox':     4,     // Guaranteed Rate Field
  'Braves':        4705,  // Truist Park
};

async function getCareerParkSplits(playerId, venueId, seasonSlg) {
  if (!venueId) return null;
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=hitting&sportId=1&sitCodes=h&gameType=R`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return null;
    const d = await r.json();

    // Try venue-specific splits
    const venueSplits = d.stats?.[0]?.splits?.filter(s =>
      s.venue?.id === venueId || s.sport?.id === venueId
    ) || [];

    // Fallback: use all home splits aggregated
    const allSplits = d.stats?.[0]?.splits || [];
    if (!allSplits.length) return null;

    // Aggregate all splits for this venue
    let ab=0, h=0, hr=0, bb=0, tb=0;
    const relevantSplits = venueSplits.length ? venueSplits : allSplits.slice(0,3);
    for (const s of relevantSplits) {
      ab += s.stat?.atBats      || 0;
      h  += s.stat?.hits        || 0;
      hr += s.stat?.homeRuns    || 0;
      bb += s.stat?.baseOnBalls || 0;
      tb += s.stat?.totalBases  || 0;
    }
    if (ab < 10) return null;

    const avg = ab > 0 ? +(h/ab).toFixed(3)  : 0;
    const slg = ab > 0 ? +(tb/ab).toFixed(3) : 0;
    const hrpa = (ab+bb) > 0 ? +(hr/(ab+bb)).toFixed(4) : 0;

    // Compare to season SLG
    const slgDiff = seasonSlg > 0 ? slg / seasonSlg : 1.0;
    const flag = slgDiff >= 1.20 ? 'boost'
               : slgDiff <= 0.80 ? 'suppressed'
               : 'neutral';

    return { ab, hr, avg, slg, hrpa, flag, slgDiff: +slgDiff.toFixed(2) };
  } catch(e) { return null; }
}

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
  // Fetch platoon splits (vsLHB/vsRHB) AND first inning splits in parallel
  const [platoonRes, f1Res] = await Promise.allSettled([
    fetch(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=pitching&sportId=1&sitCodes=vr,vl`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    ),
    fetch(
      `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statSplits&group=pitching&sportId=1&sitCodes=1st`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    ),
  ]);

  const result = { vsLHB: null, vsRHB: null, f1: null };

  // ── Platoon splits ──────────────────────────────────────────
  if (platoonRes.status === 'fulfilled' && platoonRes.value.ok) {
    const d = await platoonRes.value.json();
    const splits = d.stats?.[0]?.splits || [];

    for (const s of splits) {
      const code = s.split?.code;
      const stat = s.stat || {};
      const ab  = stat.atBats  || 0;
      const bf  = stat.battersFaced || ab;
      if (bf < 15) continue;

      const h   = stat.hits        || 0;
      const hr  = stat.homeRuns    || 0;
      const bb  = stat.baseOnBalls || 0;
      const so  = stat.strikeOuts  || 0;
      const ip  = parseFloat(stat.inningsPitched || '0') || 0;
      const er  = stat.earnedRuns  || 0;

      const era  = ip > 0 ? +(er / ip * 9).toFixed(2)   : 4.50;
      const whip = ip > 0 ? +((h + bb) / ip).toFixed(2) : 1.30;
      const kp9  = ip > 0 ? +(so / ip * 9).toFixed(1)   : 8.0;
      const hr9  = ip > 0 ? +(hr / ip * 9).toFixed(2)   : 1.20;
      const fip  = ip > 0 ? +((13*hr + 3*bb - 2*so) / ip + 3.10).toFixed(2) : 4.50;
      const babip = (ab - so - hr) > 0 ? +((h - hr) / (ab - so - hr)).toFixed(3) : 0.300;

      const entry = { bf, ab, era, fip, whip, kp9, hr9, babip, hr, bb, so };
      if (code === 'vr') result.vsRHB = entry;
      if (code === 'vl') result.vsLHB = entry;
    }
  }

  // ── First inning splits ──────────────────────────────────────
  if (f1Res.status === 'fulfilled' && f1Res.value.ok) {
    const d = await f1Res.value.json();
    // Try multiple possible structures
    const allStats = d.stats || [];
    let splits = [];
    for (const statGroup of allStats) {
      const s = statGroup.splits || [];
      if (s.length) { splits = s; break; }
    }

    console.log(`F1 splits for player: ${splits.length} splits found`);
    if (splits.length > 0) {
      console.log('F1 split codes:', splits.map(s => s.split?.code || s.split?.description).join(', '));
    }

    // Try to find first inning — various possible codes
    const f1Split = splits.find(s => {
      const code = (s.split?.code || '').toLowerCase();
      const desc = (s.split?.description || '').toLowerCase();
      return code === '1st' || code === 'i1' || code === 'inn1' || 
             desc.includes('1st inning') || desc.includes('first inning');
    }) || splits[0]; // fallback to first split if only one returned

    if (f1Split) {
      const stat = f1Split.stat || {};
      const bf  = stat.battersFaced || stat.atBats || 0;
      const h   = stat.hits        || 0;
      const hr  = stat.homeRuns    || 0;
      const bb  = stat.baseOnBalls || 0;
      const so  = stat.strikeOuts  || 0;
      const ip  = parseFloat(stat.inningsPitched || '0') || 0;
      const er  = stat.earnedRuns  || 0;
      const r   = stat.runs        || er;

      const era1    = ip > 0 ? +(er / ip * 9).toFixed(2) : null;
      const runRate = bf > 0 ? +(r / Math.max(ip, bf / 3)).toFixed(3) : null;
      const whip1   = ip > 0 ? +((h + bb) / ip).toFixed(2) : null;
      const hr9_1   = ip > 0 ? +(hr / ip * 9).toFixed(2)   : null;

      console.log(`F1 data: bf=${bf} ip=${ip} er=${er} r=${r} era1=${era1} runRate=${runRate}`);

      if (bf >= 5) {
        result.f1 = { bf, ip, er, r, hr, bb, so, era1, runRate, whip1, hr9_1 };
      }
    }
  }

  if (!result.vsLHB && !result.vsRHB && !result.f1) return null;
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  let names = [], pitchers = [], venues = {};
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    names    = body.names    || [];
    pitchers = body.pitchers || [];
    venues   = body.venues   || {}; // { playerName: { homeTeam, seasonSlg } }
  } catch(e) { return res.status(400).json({ error: 'Invalid body' }); }

  if (!names.length) return res.status(400).json({ error: 'No names' });

  const batterSplits  = {};
  const pitcherSplits = {};
  const parkSplits    = {};
  const start = Date.now();

  // ── BATTER SPLITS + PARK SPLITS ──────────────────────────────
  for (let i = 0; i < names.length; i += 5) {
    const batch = names.slice(i, i + 5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const person = await searchPlayer(name);
        if (!person) return;

        // Platoon splits
        const splits = await getBatterSplits(person.id);
        if (splits) {
          batterSplits[name] = { ...splits, batSide: person.batSide };
        } else {
          batterSplits[name] = { batSide: person.batSide, vsRHP: null, vsLHP: null };
        }

        // Park splits — only for away batters (home team's stats already reflect park)
        const venueInfo = venues[name];
        if (venueInfo?.homeTeam && venueInfo?.isAway) {
          const venueId = VENUE_IDS[venueInfo.homeTeam];
          const parkResult = await getCareerParkSplits(person.id, venueId, venueInfo.seasonSlg || 0.400);
          if (parkResult) parkSplits[name] = { ...parkResult, venue: venueInfo.homeTeam };
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
  const parkCount = Object.keys(parkSplits).length;
  console.log(`Splits: ${Object.keys(batterSplits).length} batters (${withBoth} both sides), ${Object.keys(pitcherSplits).length} pitchers (${pitWithBoth} both sides), ${parkCount} park splits, ${Date.now()-start}ms`);

  cache = { data: { splits: batterSplits, pitcherSplits, parkSplits }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=3600');
  return res.status(200).json({ splits: batterSplits, pitcherSplits, parkSplits, elapsed: Date.now() - start });
};
