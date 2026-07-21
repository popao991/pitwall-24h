# PitWall 24H

Endurance-race strategy tool for a 4-car team:

- **4 car stations** (one PC per car) — each engineer tracks fuel burn, tyre
  deg, brake pad/disc wear front & rear, and driver stints for their car,
  plans the next pit stop, and pushes it to the pit wall.
- **1 pit wall display** (5th PC in the box) — big board the mechanics read:
  per car, exactly what the next stop needs — fuel litres, tyres, driver
  change, pads/discs front & rear — with an amber "PREPARE" state and a
  flashing red "BOX BOX" when the car is coming in.

All 5 PCs run the **same app**; you pick the role on the start screen. The pit
wall PC hosts the data server; the stations connect to it over the local
network. Everything is saved to disk on every change, so a crash or restart
mid-race loses nothing.

## Race-day setup

1. **Pit wall PC**: start the app → **START PIT WALL**. The top bar shows
   `Stations connect to: <IP>` — that's the address for the other PCs. On
   first launch Windows Firewall will ask — click **Allow** (private networks).
2. **Each station PC**: start the app → pick the car (1–4), type the pit wall
   IP → **START STATION**. The badge top-right shows `connected` when live.
3. On the pit wall, press **START RACE** when the race goes green. That starts
   the 24h clock and every car's first stint.

## How a station works

- **Fuel burns by time**: while the race clock runs, the tank drains
  continuously at the active burn rate (the current driver's figure, or the
  FCY rate during an FCY) divided by the average lap time. The fuel panel
  shows burn per lap and per minute, the usable fuel above the safety level,
  and laps/time until the safety level is reached. **Finish margin** (fuel
  wanted at the flag) and **fuel safety level** (never go below) are set in
  car settings and feed every window and refuel calculation.
- **+ LAP** every time the car crosses the line (optionally type the lap time
  first) — laps drive tyre wear and stint counters (not fuel). **UNDO LAP**
  reverses a mistake; use **SET** to correct fuel to a real reading.
- **Track condition** (DRY / WET / SC-FCY) switches which burn rate and lap
  time the projections use.
- **FCY procedure** (race-wide): the amber FCY button on any station or the
  pit wall starts it for the whole field. While active, every car's fuel burn
  switches from the current driver's rate to the SC/FCY burn rate, lap-time
  projections use the SC/FCY pace, and a pulsing banner shows the FCY
  duration. Ending it returns each car to the rate of whoever is driving.
- **Correct fuel reading** overrides the fuel estimate whenever you have a
  real number from the car.
- The **NEXT STOP** banner shows what runs out first — fuel, tyres, or driver
  time — and when. The **timeline** shows driven stints (solid, coloured per
  driver), the projected rest of the current stint (faded), and projected
  future stops (red ticks) to the end of the 24 hours.
- **Brakes** accrue running hours per component (pads F/R, discs F/R) against
  the life you set; meters go amber at 75 %, red at 90 %.
- **Next pit stop** panel: set fuel (FILL / TO END / manual), toggle tyres,
  pick the next driver, toggle each brake component, add notes for the crew.
  - **SEND TO PIT WALL** → the wall card goes amber ("NEXT STOP — PREPARE").
  - **BOX BOX** → the wall card flashes red ("CAR COMING IN").
- **⚙ SETTINGS** (top bar) opens the car settings page:
  - **Car information**: name, number, make, model — shown on the pit wall too.
  - **Fuel & lap model**: tank size, burn rates and average lap per condition,
    pit-lane loss.
  - **Degradation & limits**: tyre life, tyre sets, brake pad/disc life hours
    front & rear, max stint minutes.
  - **Driver table**: per driver — name, double stints yes/no, night yes/no,
    rain yes/no, and personal fuel consumption in dry and wet (L/lap). While a
    driver is in the car, their own dry/wet figure drives the fuel burn and
    every projection; 0 falls back to the car default. Capability flags show as
    ⏩ 🌙 🌧 badges in the Drivers panel.
  - **Pit stop timing**: refuel speed (L/s) and tyre change time (s). The
    planner and the pit wall show the estimated stationary time for the
    planned stop (fuel ÷ refuel speed + tyre change, sequential) plus the
    total pit time including pit-lane loss.
  - **FCY / Code-60 calculator**: set track length and FCY speed; it shows the
    FCY lap time, the time gained per FCY lap versus green average pace, and
    the net pit-lane loss when pitting under FCY (a "free stop" when the gain
    exceeds the pit-lane loss).
  All of it can be tuned live during the race — projections update immediately.

## How the pit wall works

Each card shows the service checklist for that car's next stop. Items not
needed are dimmed; needed ones are highlighted with the amount. When the stop
is finished, the mechanic/engineer presses **✔ STOP DONE — CAR RELEASED**:
the service is applied to the car's state (fuel added, tyre/brake counters
reset, driver swapped, stint recorded) and a new stint starts.

**⚙ SETTINGS** on the pit wall holds the race settings: race name, duration
(hours) and the **race start date & time**. Schedule a start in the future and
every screen shows a T–countdown; the clock and all first stints start
automatically at that moment. **START RACE** in the top bar always starts
immediately instead. Each car's make/model set on its station appears on the
wall cards automatically.

**RESET** (double confirmation) clears the race but keeps every car's setup.

## Installing on the 5 PCs

Option A — installer with auto-update (recommended):

```
npm run dist           # creates release/PitWall24H Setup <version>.exe
```

Run that installer on each PC. Installed apps check GitHub for new releases a
few seconds after every launch and also via **CHECK FOR UPDATES** on the start
screen; a downloaded update installs on restart (or automatically when the app
closes).

Option B — portable folder (no auto-update):

```
npm run package        # creates dist/PitWall24H-win32-x64/
```

Copy that folder to each PC and run `PitWall24H.exe`.

Option C — run from source (needs Node.js): `npm install && npm start`.

## Releasing a new version

One-time setup: install the GitHub CLI, run `gh auth login`, create the
repository (`gh repo create pitwall-24h --public --source . --push`) and put
your GitHub username as `build.publish.owner` in package.json.

Then for every release:

```
1. Bump "version" in package.json  (e.g. 1.0.1)
2. git commit -am "v1.0.1"  &&  git push
3. $env:GH_TOKEN = gh auth token
4. npm run release        # builds the installer and publishes the GitHub release
```

Every installed copy on the 5 PCs picks the new version up on its next launch.

## Development

```
npm start        # run the app
npm test         # headless server/strategy-model test suite
npm run test:ui  # loads every screen in hidden windows, fails on console errors
```

Layout: `main.js` + `preload.cjs` + `app-protocol.cjs` (Electron shell),
`server/server.js` (WebSocket hub + persistence, runs inside the pit wall
instance), `shared/model.js` (state shape + all strategy math),
`renderer/` (the three screens).

State is persisted to `%APPDATA%/pitwall-24h/pitwall-state.json` on the pit
wall PC.

## Notes & limits (v1)

- Lap logging is manual (one click per lap). The server protocol is a simple
  JSON-over-WebSocket feed, so a live-timing bridge can be added later to
  push `{type:"lap", carId, lapSec}` messages automatically.
- Brake and driver-stint wear accrue by wall-clock time while the race runs;
  they fold into totals at each pit stop.
- All 4 stations may be open at once; every screen sees every change live.
