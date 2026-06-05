// api/slate.js — FAST endpoint (3-5 sec)
// Returns: today's schedule, probable pitchers, confirmed lineups, active rosters, weather

const { fetchMLBLineups, fetchRotoWireLineups, fetchProbablePitchers } = require('../lib/lineups.js');
const { fetchAllWeather } = require('../lib/weather.js');

let cache = { data: null, timestamp: null, date: null };

const TEAM_IDS = {
  Angels:108, Diamondbacks:109, Athletics:133, Orioles:110, 'Red Sox':111, Cubs:112,
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
      `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const roster = d.roster || [];

    // For batSide we need to fetch person details separately
    // The roster endpoint doesn't reliably return batSide even with hydrate
    // Use the people endpoint to get batSide for all players at once
    const ids = roster
      .filter(p => p.position?.type !== 'Pitcher' && p.person?.id)
      .map(p => p.person.id);

    if (!ids.length) return null;

    // Fetch all player details in one call
    const pr = await fetch(
      `https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(',')}&hydrate=currentTeam`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const pd = pr.ok ? await pr.json() : { people: [] };
    const personMap = {};
    for (const p of (pd.people || [])) {
      personMap[p.id] = p.batSide?.code || 'R';
    }

    return roster
      .filter(p => p.position?.type !== 'Pitcher')
      .map(p => ({
        name:    p.person?.fullName || '',
        id:      p.person?.id,
        batSide: HAND_MAP[personMap[p.person?.id]] || HAND_MAP[p.person?.batSide?.code] || 'R',
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
  // Support ?date= parameter for tomorrow's slate
  const requestedDate = req.query.date || today;
  const isTomorrow = requestedDate !== today;
  const age   = cache.timestamp ? (Date.now() - cache.timestamp) / 1000 : Infinity;

  // Cache 5 minutes same date, 30 min for tomorrow (pitchers don't change often)
  const cacheTTL = isTomorrow ? 1800 : 300;
  if (!force && cache.date === requestedDate && age < cacheTTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true, age: Math.round(age) });
  }

  const to   = ms => new Promise(r => setTimeout(() => r(null), ms));
  const safe = (p, ms) => Promise.race([p.catch(() => null), to(ms)]);
  const start = Date.now();

  // Use requestedDate throughout
  const targetDate = requestedDate;

  // Step 1: get schedule fast
  const pitchers = await safe(fetchProbablePitchers(targetDate), 8000);

  if (!pitchers?.length) {
    return res.status(200).json({
      date: targetDate, pitchers: [], lineups: {}, rosters: {}, lineupSource: 'none',
      weather: {}, confirmedCount: 0,
      timestamp: Date.now(), elapsed: Date.now() - start, error: 'No games found',
    });
  }

  // Step 2: get all teams in today's games
  const teams = [...new Set(pitchers.flatMap(g => [g.awayTeam, g.homeTeam]))];

  // Step 3: run lineups and rosters in parallel first
  // For tomorrow, skip lineup fetch (none posted yet) — rosters only
  const [mlbLineups, rotoLineups, ...rosterResults] = await Promise.all([
    isTomorrow ? Promise.resolve(null) : safe(fetchMLBLineups(targetDate), 7000),
    isTomorrow ? Promise.resolve(null) : safe(fetchRotoWireLineups(),      7000),
    ...teams.map(team => safe(fetchActiveRoster(team), 6000)),
  ]);

  // Step 4: fetch weather
  const homeTeams = pitchers.map(g => g.homeTeam).filter(Boolean);
  const weather = await safe(fetchAllWeather(targetDate, homeTeams), 9000);

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
    date: targetDate, pitchers, lineups, rosters, lineupSource,
    weather: weather || {}, confirmedCount,
    timestamp: Date.now(), elapsed: Date.now() - start,
  };

  cache = { data, timestamp: Date.now(), date: targetDate };
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json(data);
};
