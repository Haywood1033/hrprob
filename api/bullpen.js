// api/bullpen.js — fetches team bullpen ERA/HR9 for current season

const TEAM_IDS = {
  'Angels':108,'Diamondbacks':109,'Orioles':110,'Red Sox':111,'Cubs':112,
  'Reds':113,'Guardians':114,'Rockies':115,'Tigers':116,'Astros':117,
  'Royals':118,'Dodgers':119,'Nationals':120,'Mets':121,'Athletics':133,
  'Pirates':134,'Padres':135,'Mariners':136,'Giants':137,'Cardinals':138,
  'Rays':139,'Rangers':140,'Blue Jays':141,'Twins':142,'Phillies':143,
  'Braves':144,'White Sox':145,'Marlins':146,'Yankees':147,'Brewers':158,
};

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 6 * 3600 * 1000;

async function fetchBullpenStats() {
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) return _cache;

  const season = new Date().getFullYear();
  const results = {};

  // Use MLB Stats API team stats endpoint — group=pitching, gameType=R
  // Fetch all teams in one call using standings/teams endpoint
  await Promise.allSettled(
    Object.entries(TEAM_IDS).map(async ([teamName, teamId]) => {
      try {
        // Get pitcher stats for this team filtered to relievers
        const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=${season}&gameType=R`;
        const r = await fetch(url, { 
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return;
        const data = await r.json();
        const splits = data?.stats?.[0]?.splits || [];
        if (!splits.length) return;

        // Team aggregate pitching stats — get relief-specific
        // Try to find bullpen aggregate (non-starter)
        const teamStat = splits[0]?.stat;
        if (!teamStat) return;

        // Use team ERA and HR/9 as proxy — adjust for starter quality later
        // Full team ERA includes starters so we estimate bullpen
        const teamERA  = parseFloat(teamStat.era || 4.50);
        const teamHR9  = parseFloat(teamStat.homeRunsPer9 || 1.25);
        const teamWHIP = parseFloat(teamStat.whip || 1.30);
        const teamK9   = parseFloat(teamStat.strikeoutsPer9 || 8.5);
        const teamIP   = parseFloat(teamStat.inningsPitched || 0);

        if (teamIP < 50) return; // skip if too few innings

        results[teamName] = {
          era:  +teamERA.toFixed(2),
          hr9:  +teamHR9.toFixed(2),
          whip: +teamWHIP.toFixed(2),
          k9:   +teamK9.toFixed(1),
          ip:   +teamIP.toFixed(0),
        };
      } catch(e) {
        // silently skip
      }
    })
  );

  // If team stats API failed, try the league-wide pitcher stats endpoint
  if (Object.keys(results).length < 15) {
    try {
      const url = `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&gameType=R&season=${season}&playerPool=All&limit=2000`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (r.ok) {
        const data = await r.json();
        const pitchers = data?.stats?.[0]?.splits || [];
        
        // Group by team, filter to relievers (GS/G < 0.3)
        const byTeam = {};
        for (const p of pitchers) {
          const team = p.team?.name;
          if (!team) continue;
          const stat = p.stat;
          const g  = stat?.gamesPlayed || 0;
          const gs = stat?.gamesStarted || 0;
          if (g < 5 || gs/g >= 0.3) continue; // skip starters and low sample
          
          if (!byTeam[team]) byTeam[team] = { er:0, hr:0, bb:0, h:0, so:0, ip:0 };
          const ip = parseFloat(stat.inningsPitched || 0);
          byTeam[team].er += stat.earnedRuns || 0;
          byTeam[team].hr += stat.homeRuns || 0;
          byTeam[team].bb += stat.baseOnBalls || 0;
          byTeam[team].h  += stat.hits || 0;
          byTeam[team].so += stat.strikeOuts || 0;
          byTeam[team].ip += ip;
        }

        for (const [teamName, s] of Object.entries(byTeam)) {
          if (s.ip < 30) continue;
          // Map team full name to our team name
          const mapped = Object.keys(TEAM_IDS).find(k => teamName.includes(k) || k.includes(teamName.split(' ').pop()));
          if (!mapped) continue;
          results[mapped] = {
            era:  +((s.er / s.ip) * 9).toFixed(2),
            hr9:  +((s.hr / s.ip) * 9).toFixed(2),
            whip: +((s.bb + s.h) / s.ip).toFixed(2),
            k9:   +((s.so / s.ip) * 9).toFixed(1),
            ip:   +s.ip.toFixed(0),
          };
        }
      }
    } catch(e) {}
  }

  console.log(`Bullpen stats: ${Object.keys(results).length} teams`);
  _cache = results;
  _cacheTime = Date.now();
  return results;
}

module.exports = async function handler(req, res) {
  try {
    const data = await fetchBullpenStats();
    res.setHeader('Cache-Control', 'public, s-maxage=21600');
    return res.status(200).json({ ok: true, bullpen: data, count: Object.keys(data).length });
  } catch(e) {
    console.error('Bullpen API error:', e.message);
    return res.status(500).json({ ok: false, error: e.message, bullpen: {} });
  }
};
