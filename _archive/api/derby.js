// api/derby.js — fetches live Home Run Derby scoring from MLB Stats API
// Polls every 30 seconds during the Derby (July 13, 2026)

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds during live event

// Derby player IDs for MLB Stats API lookup
const DERBY_PLAYER_IDS = {
  'Kyle Schwarber':    656941,
  'Bryce Harper':      547180,
  'Junior Caminero':   695479,
  'Willson Contreras': 575929,
  'Munetaka Murakami': 808967,
  'Ben Rice':          694192,
  'Jac Caglianone':    702255,
  'Jordan Walker':     726723,
};

async function fetchDerbyData() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  try {
    // Step 1: Find the Derby game on the schedule
    const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-07-13&gameType=A,E,S,R,N`;
    const schedR = await fetch(scheduleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    
    if (!schedR.ok) throw new Error('Schedule fetch failed');
    const schedData = await schedR.json();
    
    // Find Home Run Derby game
    let derbyPk = null;
    const games = schedData?.dates?.[0]?.games || [];
    for (const g of games) {
      const desc = (g.description || '').toLowerCase();
      const gtype = g.gameType || '';
      if (desc.includes('home run derby') || desc.includes('derby') || gtype === 'N') {
        derbyPk = g.gamePk;
        break;
      }
    }

    // If no game found via schedule, try known Derby gamePk patterns
    // Derby typically uses a special gamePk — try fetching all A-type games
    if (!derbyPk) {
      // Return static data with "not started" status
      const result = {
        status: 'pregame',
        derbyPk: null,
        players: Object.keys(DERBY_PLAYER_IDS).map(name => ({
          name,
          r1HRs: null,
          r2HRs: null,
          finalHRs: null,
          eliminated: false,
          winner: false,
        })),
        currentRound: 0,
        currentPlayer: null,
        currentHRs: 0,
        currentSwings: 0,
      };
      _cache = result;
      _cacheTime = Date.now();
      return result;
    }

    // Step 2: Fetch live game data
    const liveUrl = `https://statsapi.mlb.com/api/v1.1/game/${derbyPk}/feed/live`;
    const liveR = await fetch(liveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });

    if (!liveR.ok) throw new Error('Live feed failed');
    const liveData = await liveR.json();

    const status = liveData?.gameData?.status?.abstractGameState || 'Preview';
    const plays  = liveData?.liveData?.plays?.allPlays || [];
    
    // Parse HR counts per player per round from play-by-play
    const playerStats = {};
    for (const [name] of Object.entries(DERBY_PLAYER_IDS)) {
      playerStats[name] = { r1HRs: 0, r2HRs: 0, finalHRs: 0, swings: 0, eliminated: false, winner: false };
    }

    // Parse plays for HR events
    for (const play of plays) {
      const batter = play?.matchup?.batter?.fullName;
      const result = play?.result?.eventType;
      const inning = play?.about?.inning;
      if (!batter || !playerStats[batter]) continue;
      if (result === 'home_run') {
        if (inning === 1) playerStats[batter].r1HRs++;
        else if (inning === 2) playerStats[batter].r2HRs++;
        else if (inning === 3) playerStats[batter].finalHRs++;
      }
      playerStats[batter].swings++;
    }

    // Current batter
    const currentPlay = liveData?.liveData?.plays?.currentPlay;
    const currentPlayer = currentPlay?.matchup?.batter?.fullName || null;
    const currentHRs = currentPlay ? (playerStats[currentPlayer]?.r1HRs || 0) : 0;

    const result = {
      status: status === 'Live' ? 'live' : status === 'Final' ? 'final' : 'pregame',
      derbyPk,
      players: Object.entries(playerStats).map(([name, stats]) => ({ name, ...stats })),
      currentPlayer,
      currentRound: liveData?.liveData?.linescore?.currentInning || 0,
    };

    _cache = result;
    _cacheTime = Date.now();
    return result;

  } catch(e) {
    console.error('Derby API error:', e.message);
    // Return cached data on error if available
    if (_cache) return _cache;
    return { status: 'pregame', players: [], error: e.message };
  }
}

module.exports = async function handler(req, res) {
  try {
    const data = await fetchDerbyData();
    res.setHeader('Cache-Control', 'no-cache, no-store');
    return res.status(200).json({ ok: true, ...data });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
