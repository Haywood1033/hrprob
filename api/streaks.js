// api/streaks.js — fetches last 14 game stats for a list of player names
// Called once after Statcast loads with top 40 player names

const TEAM_MAP = {
  108:'Angels',109:'Athletics',110:'Orioles',111:'Red Sox',112:'Cubs',
  113:'Reds',114:'Guardians',115:'Rockies',116:'Tigers',117:'Astros',
  118:'Royals',119:'Dodgers',120:'Nationals',121:'Mets',133:'Athletics',
  134:'Pirates',135:'Padres',136:'Mariners',137:'Giants',138:'Cardinals',
  139:'Rays',140:'Rangers',141:'Blue Jays',142:'Twins',143:'Phillies',
  144:'Braves',145:'White Sox',146:'Marlins',147:'Yankees',158:'Brewers',
};

// Cache to avoid re-fetching within same session
let cache = { data: null, timestamp: null };
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function searchPlayer(name) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(name)}&sportIds=1&active=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d.people?.[0]?.id || null;
}

async function getLastXGames(playerId, limit = 14) {
  const r = await fetch(
    `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=lastXGames&limit=${limit}&group=hitting&sportId=1`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const splits = d.stats?.[0]?.splits || [];
  
  let hr=0, h=0, ab=0, tb=0, bb=0;
  for (const s of splits) {
    hr += s.stat?.homeRuns    || 0;
    h  += s.stat?.hits        || 0;
    ab += s.stat?.atBats      || 0;
    tb += s.stat?.totalBases  || 0;
    bb += s.stat?.baseOnBalls || 0;
  }
  const avg = ab > 0 ? +(h/ab).toFixed(3)  : 0;
  const slg = ab > 0 ? +(tb/ab).toFixed(3) : 0;
  const obp = (ab+bb) > 0 ? +((h+bb)/(ab+bb)).toFixed(3) : 0;
  
  let flame = '';
  if      (hr >= 3)                 flame = '🔥🔥';
  else if (hr >= 1)                 flame = '🔥';
  else if (ab >= 20 && slg < 0.350) flame = '❄️';
  
  return { hr, avg, slg, obp, ab, games: splits.length, flame };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Return cache if fresh
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  let names = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    names = body.names || [];
  } catch(e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  if (!names.length) return res.status(400).json({ error: 'No names provided' });

  const results = {};
  const start = Date.now();

  // Process in batches of 5 to stay within timeout
  for (let i = 0; i < Math.min(names.length, 40); i += 5) {
    const batch = names.slice(i, i+5);
    await Promise.allSettled(batch.map(async name => {
      try {
        const id = await searchPlayer(name);
        if (!id) return;
        const stats = await getLastXGames(id);
        if (stats) results[name] = stats;
      } catch(e) {
        console.warn(`Streak ${name}:`, e.message);
      }
    }));
  }

  console.log(`Streaks: ${Object.keys(results).length}/${names.length} in ${Date.now()-start}ms`);

  cache = { data: { streaks: results }, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=1800');
  return res.status(200).json({ streaks: results, elapsed: Date.now()-start });
};
