// api/slate.js — FAST endpoint (3-5 sec)
// Returns: today's schedule, probable pitchers, confirmed lineups, active rosters, weather

const { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers } = require('../lib/lineups.js');
const { fetchAllWeather } = require('../lib/weather.js');

let cache = { data: null, timestamp: null, date: null };

const TEAM_IDS = {
  Angels:108, Athletics:133, Orioles:110, 'Red Sox':111, Cubs:112,
  Reds:113, Guardians:114, Rockies:115, Tigers:116, Astros:117,
  Royals:118, Dodgers:119, Nationals:120, Mets:121, Pirates:134,
  Padres:135, Mariners:136, Giants:137, Cardinals:138, Rays:139,
  Rangers:140, 'Blue Jays':141, Twins:142, Phillies:143, Braves:144,
  'White Sox':145, Marlins:146, Yankees:147, Brewers:158,
};

const HAND_MAP = { R:'R', L:'L', S:'S' };

async function fetchActiveRoster(teamName) {
  const teamId = TEAM_IDS[teamName];
  if (!teamId) return null;
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person(batSide)`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const roster = d.roster || [];
    // Return batters only (position players), exclude pitchers
    return roster
      .filter(p => p.position?.type !== 'Pitcher')
      .map(p => ({
        name:    p.person?.fullName || '',
        id:      p.person?.id,
        batSide: HAND_MAP[p.person?.batSide?.code] || 'R',
        pos:     p.position?.abbreviation || '?',
        source:  'projected',
      }))
      .filter(p => p.name);
  } catch(e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const today = new Date(etStr).toLocaleDateString('en-CA');
  const force = req.query.force === 'true';
  const age   = cache.timestamp ? (Date.now() - cache.timestamp) / 1000 : Infinity;

  // Cache 5 minutes same date
  if (!force && cache.date === today && age < 300 && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true, age: Math.round(age) });
  }

  const to   = ms => new Promise(r => setTimeout(() => r(null), ms));
  const safe = (p, ms) => Promise.race([p.catch(() => null), to(ms)]);
  const start = Date.now();

  // Step 1: get schedule fast
  const pitchers = await safe(fetchProbablePitchers(today), 8000);

  if (!pitchers?.length) {
    return res.status(200).json({
      date: today, pitchers: [], lineups: {}, rosters: {}, lineupSource: 'none',
      weather: {}, confirmedCount: 0,
      timestamp: Date.now(), elapsed: Date.now() - start, error: 'No games found',
    });
  }

  // Step 2: get all teams in today's games
  const teams = [...new Set(pitchers.flatMap(g => [g.awayTeam, g.homeTeam]))];

  // Step 3: run lineups, rosters, weather in parallel
  const [mlbLineups, rotoLineups, weather, ...rosterResults] = await Promise.all([
    safe(fetchMLBLineups(today),  7000),
    safe(fetchRotoWireLineups(),  7000),
    safe(fetchAllWeather(today),  8000),
    ...teams.map(team => safe(fetchActiveRoster(team), 6000)),
  ]);

  // Build rosters map
  const rosters = {};
  teams.forEach((team, i) => {
    if (rosterResults[i]) rosters[team] = rosterResults[i];
  });

  const lineups      = mlbLineups || rotoLineups || {};
  const lineupSource = mlbLineups ? 'mlb.com' : rotoLineups ? 'rotowire.com' : 'none';
  const confirmedCount = Object.keys(lineups).length;
  const rosterCount    = Object.keys(rosters).length;

  console.log(`slate ${today}: ${pitchers.length} games, ${confirmedCount} lineups, ${rosterCount} rosters, ${Date.now()-start}ms`);

  const data = {
    date: today, pitchers, lineups, rosters, lineupSource,
    weather: weather || {}, confirmedCount,
    timestamp: Date.now(), elapsed: Date.now() - start,
  };

  cache = { data, timestamp: Date.now(), date: today };
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json(data);
};
