# MLB HR Probability Engine — Vercel Deployment

## What this is
A live MLB HR probability analytics tool powered by real Statcast data.

## Data sources
- **Batters**: Baseball Savant EV, Barrel%, Hard-Hit%, xwOBA, ISO (2026 season)
- **Pitchers**: Baseball Savant xERA, Whiff%, HR/9, pitch arsenal
- **Lineups**: MLB.com starting-lineups page + RotoWire backup (refreshed every 5 min)
- **Weather**: Open-Meteo hourly forecast at game time (free, no auth)
- **Park factors**: Baked-in with Statcast park factors

## Deploy to Vercel (5 minutes)

### Step 1: Create a GitHub repository
1. Go to github.com → New Repository → name it `hrprob`
2. Upload all files from this folder

### Step 2: Deploy to Vercel
1. Go to vercel.com → New Project
2. Import your GitHub repo
3. Click Deploy — done

### Step 3: Your URL
Vercel gives you a URL like `hrprob.vercel.app`.
Open it from any device — phone, tablet, desktop.

## How it updates
- `/api/refresh` runs every 5 minutes via Vercel Cron
- Fetches confirmed lineups from MLB.com + RotoWire
- Fetches fresh Statcast data from Baseball Savant
- Fetches live weather from Open-Meteo
- Frontend polls `/api/data` on load and every 5 minutes

## Development
```bash
npm install
npx vercel dev
# Open http://localhost:3000
```

## File structure
```
/api
  refresh.js    — cron endpoint, fetches all live data
  data.js       — frontend data endpoint
/lib
  statcast.js   — Baseball Savant Statcast fetcher
  lineups.js    — MLB.com + RotoWire lineup scraper
  weather.js    — Open-Meteo weather fetcher
/public
  index.html    — the app (HTML + CSS + JS)
vercel.json     — Vercel config + cron schedule
package.json    — dependencies
```
