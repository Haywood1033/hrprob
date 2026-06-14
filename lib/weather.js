// lib/weather.js — CommonJS
const PARK_COORDS = {
  'Guardians':    { lat:41.496, lon:-81.685, dome:false },
  'Tigers':       { lat:42.339, lon:-83.049, dome:false },
  'Pirates':      { lat:40.447, lon:-80.006, dome:false },
  'Cardinals':    { lat:38.623, lon:-90.193, dome:false },
  'Mets':         { lat:40.757, lon:-73.845, dome:false },
  'Nationals':    { lat:38.873, lon:-77.007, dome:false },
  'Braves':       { lat:33.735, lon:-84.389, dome:false },
  'Marlins':      { lat:25.778, lon:-80.220, dome:true  },
  'Blue Jays':    { lat:43.641, lon:-79.389, dome:false },
  'Yankees':      { lat:40.829, lon:-73.926, dome:false },
  'Athletics':    { lat:38.580, lon:-121.503,dome:false },
  'Angels':       { lat:33.800, lon:-117.883,dome:false },
  'Rockies':      { lat:39.756, lon:-104.994,dome:false },
  'Diamondbacks': { lat:33.446, lon:-112.067,dome:true  },
  'Giants':       { lat:37.779, lon:-122.389,dome:false },
  'Dodgers':      { lat:34.074, lon:-118.240,dome:false },
  'Padres':       { lat:32.707, lon:-117.157,dome:false },
  'Mariners':     { lat:47.591, lon:-122.332,dome:true  },
  'Astros':       { lat:29.757, lon:-95.355, dome:true  },
  'Royals':       { lat:39.051, lon:-94.481, dome:false },
  'Red Sox':      { lat:42.347, lon:-71.097, dome:false },
  'Twins':        { lat:44.982, lon:-93.278, dome:false },
  'Rangers':      { lat:32.751, lon:-97.082, dome:true  },
  'Rays':         { lat:27.768, lon:-82.653, dome:true  },
  'Orioles':      { lat:39.284, lon:-76.621, dome:false },
  'White Sox':    { lat:41.830, lon:-87.634, dome:false },
  'Brewers':      { lat:43.028, lon:-87.971, dome:false },
  'Cubs':         { lat:41.948, lon:-87.655, dome:false },
  'Reds':         { lat:39.097, lon:-84.507, dome:false },
  'Phillies':     { lat:39.906, lon:-75.167, dome:false },
};

const PARK_ORIENTATION = {
  'Guardians':70,'Tigers':220,'Pirates':110,'Cardinals':210,'Mets':175,
  'Nationals':130,'Braves':30,'Blue Jays':10,'Yankees':200,'Athletics':115,
  'Angels':230,'Rockies':185,'Giants':100,'Dodgers':45,'Padres':270,
  'Royals':5,'Red Sox':70,'Twins':30,'Orioles':115,'White Sox':135,
  'Brewers':200,'Cubs':10,'Reds':150,'Phillies':215,
};

const CARDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function windLabel(windDir, team) {
  const o = PARK_ORIENTATION[team];
  if (o === undefined) return 'crosswind';
  const diff = ((windDir - o) % 360 + 360) % 360;
  if (diff < 45 || diff > 315) return 'blowing out';
  if (diff > 135 && diff < 225) return 'blowing in';
  return 'crosswind';
}

function weatherCode(code) {
  if (code <= 1) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 49) return 'Foggy';
  if (code <= 69) return 'Rainy';
  if (code <= 79) return 'Snow';
  return 'Thunderstorm';
}

async function fetchAllWeather(gameDate, gameTeams = []) {
  const results = {};

  // Dome parks — always static
  for (const [team, info] of Object.entries(PARK_COORDS)) {
    if (info.dome) results[team] = { t:72, h:50, w:0, d:999, c:'—', l:'dome', s:'Dome', dome:true };
  }

  const outdoor = Object.entries(PARK_COORDS)
    .filter(([t, info]) => !info.dome && (gameTeams.length === 0 || gameTeams.includes(t)));

  if (!outdoor.length) return results;

  // Single multi-location request — returns array of results, one per location
  // Use timezone=auto so each city gets correct local time
  const lats = outdoor.map(([, info]) => info.lat).join(',');
  const lons = outdoor.map(([, info]) => info.lon).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=2`;

  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    // Multi-location response is always an array
    const responses = Array.isArray(d) ? d : [d];

    responses.forEach((data, idx) => {
      const [team] = outdoor[idx];
      const hourly = data?.hourly;
      if (!hourly?.time?.length) return;

      // Find best hour index — times are in local timezone due to timezone=auto
      // Game times: afternoon (4pm) through night (10pm)
      const datePrefix = gameDate;
      const targets = ['T19:00','T18:00','T20:00','T17:00','T21:00','T16:00'];
      let hi = -1;
      for (const t of targets) {
        hi = hourly.time.findIndex(x => x === `${datePrefix}${t}`);
        if (hi >= 0) break;
      }
      if (hi < 0) hi = hourly.time.findIndex(t => t.startsWith(datePrefix));
      if (hi < 0) hi = 12;

      const t    = Math.round(hourly.temperature_2m[hi]);
      const w    = Math.round(hourly.wind_speed_10m[hi]);
      const wdir = Math.round(hourly.wind_direction_10m[hi]);
      const code = hourly.weather_code[hi];
      results[team] = { t, w, d: wdir, c: CARDS[Math.round(wdir/22.5)%16], l: windLabel(wdir, team), s: weatherCode(code), dome: false, src: 'live' };
    });

    console.log(`Weather batch: ${responses.length} locations fetched, ${Object.keys(results).filter(k=>!results[k].dome).length} outdoor parks`);
  } catch(e) {
    console.warn('Weather batch fetch failed:', e.message);
  }

  return results;
}

module.exports = { fetchAllWeather };
