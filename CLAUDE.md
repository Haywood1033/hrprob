# HRProb — MLB HR Probability Engine
## Claude Code Project Context

---

## What this is
A full-stack MLB home run probability engine deployed at **hrprob-9rx8.vercel.app**. The app predicts HR probability for every batter on the daily slate using Statcast data, pitcher matchups, park/weather conditions, and a signal convergence system. Built over 11 sessions of iterative development.

---

## Architecture

### File Structure
```
/
├── app.html              # Main app (~8,500 lines) — single-file frontend
├── index.html            # Landing page
├── api/
│   ├── slate.js          # Primary data endpoint — schedule, lineups, pitchers, weather
│   ├── history.js        # Supabase DB — prediction history, results, signal lock
│   ├── statcast.js       # Baseball Savant CSV fetch and parse
│   ├── streaks.js        # MLB Stats API game logs and streak calculation
│   ├── splits.js         # Platoon splits, pitcher splits, park splits
│   └── bullpen.js        # Team bullpen ERA and HR/9
├── lib/
│   ├── weather.js        # Open-Meteo weather fetch — temp, wind, pressure, humidity
│   └── statcast.js       # Statcast data builder (CSV parsing, batter/pitcher stats)
└── vercel.json           # Rewrite rules — /app → app.html
```

### Data Sources
- **Baseball Savant** — barrel%, EV, xwOBA, ISO, HH%, launch angle, pull%, FB%, whiff%
- **MLB Stats API** — schedule, lineups, probable pitchers, game logs, platoon splits
- **Open-Meteo** — temperature, wind speed/direction, barometric pressure, humidity
- **Supabase** — PostgreSQL DB for prediction history, signal lock, accuracy tracking

### Deployment
- **Vercel** — auto-deploys from GitHub main branch
- **Supabase** — `daily_predictions` table stores predictions, signal lock, results
- Environment variables needed: `SUPABASE_URL`, `SUPABASE_KEY`

---

## Core Model

### HR Probability (`hrProb()` in app.html ~line 817)
Base probability from Statcast metrics, then adjusted for:
- Park factor, elevation, wind (continuous cosine carry model)
- Temperature, barometric pressure, humidity
- Pitcher xERA, HR/9, HH%, whiff%
- Platoon splits (batter hand vs pitcher hand)
- Batting order position
- Career H2H history vs this pitcher
- Launch angle (22-32° HR corridor = bonus)
- Bullpen exposure

**Calibration** (54-day, 3,727 predictions):
- 20%+: ×0.74
- 15-19%: no adjustment
- 10-14%: no adjustment
- 5-9%: no adjustment

### Signal System (8 signals, `getSignals()` ~line 2687)
1. 🏟 Hitter Park — park factor ≥1.05
2. 💨 Wind Out — blowing out ≥6mph
3. 🎯 Pitcher Matchup — xERA ≥4.80 OR HR/9 ≥1.40
4. 🔥 Hot Streak — flame from game log
5. 🔒 High Confidence — 200+ PA sample
6. 🏏 Pull Air Edge — Pull% ≥40% + FB% ≥35%
7. ⚔️ Pitch Edge — xwOBA ≥.360 vs primary pitch type
8. 💥 Hot Contact — barrel% ≥12% OR HH% ≥50% OR L10 SLG ≥.650 AND LA in 20-35°

**Badge thresholds:** Elite=6+, All-Star=5, Value=4

### Signal Lock (`lockSignals()`, `getSignalsLocked()` ~line 2818)
**Critical system** — locks badges and counts once per day so they never change after pre-game.

Key globals:
- `SIGNAL_LOCK` — stores `{ signals, count, badge, hrp, ci }` per player
- `_signalLockDate` — date lock was built
- `_lockRestoredFromDB` — prevents slate from wiping a DB-restored lock
- `_simInitialized` — prevents game list from auto-repopulating after clear

Lock builds ONCE after all three data sources confirm loaded:
- `_loadState.statcast` — Statcast EV/barrel/pitch data
- `_loadState.streaks` — game logs and flames
- `_loadState.splits` — platoon and park splits

Lock is saved to Supabase `daily_predictions.signal_lock` and restored on page reload.

**Known issue history:** The slate date change detection was incorrectly clearing the DB-restored lock on first page load. Fixed with `_lockRestoredFromDB` flag.

---

## Tab Structure
```
⚡ Today | 🔴 Live | ☰ Players | ⚾ Pitchers | 🎯 Best Plays | 📋 Props |
🔍 Pulse | ⚔️ Edge | 🎰 Parlays | 📅 Tomorrow | 🏟 Parks | 🎯 Sharp Plays | 📊 Accuracy
```

### Key Render Functions
- `renderToday()` — main Today tab with Best Play card, signal grid, environment section
- `renderTargets()` — Best Plays cheat sheet table (fixed-column, tier-sorted)
- `renderSimulate()` — Sharp Plays daily briefing (triple convergence filter)
- `renderParks()` — Parks & Weather tab with HR Weather composite score
- `renderLive()` — Live HR tracker with scorecard
- `renderHistory()` / accuracy tab — 54-day backtest with tier breakdown
- `renderAll()` — dispatches to current view's render function

---

## Key Global State
```javascript
// Data stores
BATTER{}          // Statcast batter data — ev, ba (barrel%), hh, xw, iso, la, pull_pct, fb_pct
PITCHER{}         // Statcast pitcher data — xera, hr9, hh, whiff, era
PITCHER_ARSENAL{} // Pitch mix by type — usage%, whiff%, xwOBA
BATTER_VS_PITCH{} // Batter xwOBA vs each pitch type
BATTER_L7{}       // Last 7 days rolling (season data with date filter)
STREAK{}          // Game log, flame, HR count, SLG
SPLITS{}          // Batter platoon splits
PITCHER_SPLITS{}  // Pitcher splits + hand
PARK_SPLITS{}     // Batter career splits by park
WX{}              // Weather per team — t, ws, wd, pres, hum, c, dome
games[]           // Today's games with lineups
allRows[]         // All batter rows for today's slate
historyRecords[]  // 200 days of prediction history from Supabase
SIGNAL_LOCK{}     // Immutable daily lock
H2H_CACHE{}       // Career H2H cache

// Load state
_loadState = { slate, statcast, streaks, splits }
_signalLockDate   // Date lock was built
_lockRestoredFromDB // Flag: prevents slate clearing DB-restored lock
historyLoaded     // Flag: history has been loaded from DB
```

---

## Known Issues / Tech Debt

### High Priority
- **Console.log cleanup** — hundreds of debug logs throughout, needs cleanup before public launch
- **Load time** — 30-60 second initial load due to multiple sequential API calls. Needs pre-built daily cache
- **app.html size** — ~8,500 lines in a single file. Should be split into modules

### Medium Priority
- **L7 rolling metrics** — Baseball Savant date filter doesn't reliably work, using season data as proxy
- **HR/BBE** — `p_hr_per_fb` column name inconsistent across Savant endpoints
- **Today tab bounce** — multiple rebuild() calls cause visual re-renders as data loads. Debouncing attempted but reverted due to data integrity concerns

### Low Priority
- **Live odds integration** — The-Odds-API planned but not implemented. ML/F5 leans are model-only
- **PWA** — planned after load time improvements
- **X bot** — planned for morning picks and HR celebrations
- **Auth + subscription** — Clerk/Supabase, Stripe — planned for next season

---

## Accuracy & Calibration
- **54 days of data**, 3,727 predictions tracked
- 20%+ tier: model 22.2% → actual 16.4% (×0.74 correction applied)
- 15-19%: model 17.3% → actual 17.6% (no correction — accurate)
- 10-14%: model 12.4% → actual 12.9% (no correction — accurate)
- 5-9%: model 7.7% → actual 9.2% (no correction — boost removed, hurt results)
- Signal play (4+ signals) hit rate: ~33% season average, peaks 45-50% on strong nights

---

## Weather System
Two separate weather fetch paths (known inconsistency):
1. **`lib/weather.js`** — called from `api/slate.js`, returns `{ t, w, d, c, l, s, dome, pres, hum }`
2. **Frontend `loadWeather()`** in app.html — fetches Open-Meteo directly, returns `{ t, ws, wd, dome, pres, hum, c }`

The frontend path uses `ws`/`wd` (not `w`/`d`). `renderParks()` uses the frontend WX object so uses `wx.ws`/`wx.wd`. The lib version is used by the slate API. Field names differ — be careful when modifying weather code.

---

## Supabase Schema
```sql
daily_predictions (
  date          TEXT PRIMARY KEY,
  predictions   JSONB,   -- array of { name, hrp, hit, team, order, gamePk }
  signal_lock   JSONB,   -- { playerName: { signals, count, badge, hrp, ci } }
  game_leans    JSONB,   -- ML/F5 leans
  results_added BOOLEAN,
  summary       JSONB,
  saved_at      TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ
)
```

---

## Sharp Plays Filter (renderSimulate)
Triple convergence — all three must be true:
- 5+ signals
- 14%+ HR probability (locked)
- xERA ≥4.80 OR HR/9 ≥1.40

Max 5 plays shown. Sorted: Elite → All-Star → Value → conviction score within tier.

Fades section: players with 4+ signals / 12%+ HR who almost qualified but have a red flag (3+ consecutive HR days, pitcher whiff% ≥30%, facing ace with <6 signals).

---

## Business Context
- Personal use tool built over summer 2026
- Considering PA LLC formation and monetization next season
- No live odds integration yet
- No auth/paywall yet
- Deployed publicly at hrprob-9rx8.vercel.app but not marketed
- GitHub: Haywood1033/hrprob

---

## Development Notes
- Always run `node --check` on app.html's script block after edits
- `saveToHistory()` runs ~1pm ET after lineups confirm — saves predictions to Supabase
- `autoFetchResults()` runs after games end — fetches actual HR outcomes and saves hit/miss
- Signal lock saves to DB when built, restores from DB on page reload
- Vercel deploys automatically on push to main branch
- Hard refresh (Cmd+Shift+R) often needed after deploy to bust cache
