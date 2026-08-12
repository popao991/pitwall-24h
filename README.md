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
   Leaving the IP empty connects to `127.0.0.1` — a pit wall running on the
   same PC (handy for testing both roles on one machine). The address, port
   and car slot can be changed later from the running station under
   **⚙ SETTINGS → CONNECTION**.
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
- **Fuel pit window** (automatic): the liters that still have to be added at
  pit stops before the flag do not change while the car circulates — every lap
  burns from the tank and shrinks the need by the same amount. So refuelling
  early can only waste time one way: by adding a whole extra stop. The fuel
  panel shows the **fewest fuel stops that still reach the flag** (plus the
  minimum total pit time they cost) and the **pit window**: *closed* — a stop
  now would add an extra pit-lane loss, opens in N laps — or *OPEN* — box any
  time before the tank hits the safety level, same total time, with the level
  to fill to. The projection always runs on green pace, even during a
  neutralisation, so the window never jumps when a flag flies.
- **Low fuel warning**: once the tank is down to the warning threshold
  (SETTINGS → FUEL → *Low-fuel warning (laps)*, default 5, 0 = off) a banner
  appears with the laps and time left above the safety level — amber first,
  red and flashing from 2 laps. It is muted while the car is already in the
  pit lane and when the maths says the fuel reaches the flag anyway.
- **🅿 CAR IN PIT LANE** (station or wall card): mark the car when it enters
  the pit lane — fuel burn pauses while it is in there. A completed stop
  (STOP DONE on the wall) releases it automatically; press the button again
  on the station for a drive-through with no service.
- **+ LAP** every time the car crosses the line (optionally type the lap time
  first) — laps drive tyre wear and stint counters (not fuel). **UNDO LAP**
  reverses a mistake; use **SET** to correct fuel to a real reading.
- **Track condition** (DRY / WET) switches which burn rate and lap time the
  projections use. Neutralisations are *not* a track condition — they are
  race-wide and live on the FCY / SC / RED buttons directly below.
- **Race condition** (race-wide): the race is always in exactly one condition,
  taken from the live timing feed's flag with a manual override on top. It is
  the single thing that drives fuel burn, lap-time projections and the alert
  styling on every screen.

  | Condition | Fuel & lap model | Top bar |
  | --- | --- | --- |
  | GREEN | the driver's own rate | **untouched** — green is the normal state and must not compete for attention |
  | FULL COURSE YELLOW / CODE 60 | the car's FCY rate | flashing yellow |
  | SAFETY CAR | the car's Safety Car rate | flashing yellow, labelled SAFETY CAR |
  | RED FLAG | burn stops | solid red, steady |
  | CHEQUERED FLAG | burn stops | solid, steady |

  Only the conditions that change a pit decision *right now* flash — reserving
  the animation is what keeps it meaningful over 24 hours. The condition block
  always spells the state out in words, so colour and motion are reinforcement
  rather than the only signal (it also degrades correctly under
  `prefers-reduced-motion`).

  **Safety Car and FCY / Code 60 have separate burn rates and lap times.**
  Behind the Safety Car the field still circulates at a fair pace; FCY and
  Code 60 hold a fixed delta speed, so the lap is slower but leaner. Both pairs
  are per car under SETTINGS → FUEL. A car tuned before the split inherits its
  Safety Car figures for FCY until they are edited.

  When the feed reports a neutralisation, **all four cars switch automatically**
  — no button press needed. Next to it sit the **manual FCY / SC / RED
  buttons**, on the pit wall and on every station, for when the feed is late,
  wrong, or absent: pressing one starts that condition for the whole field on
  every screen, pressing it again ends it for everyone — whoever at the wall
  or in the garage sees the boards first makes the call (crowd-sourced
  intervention). Ending a condition the feed still reports holds FORCED GREEN
  against it; any override releases back to AUTO the next time the feed's flag
  genuinely changes, so a stale call cannot latch for the rest of the race.
  Forcing green can never hide a red flag the feed reports, and a feed red
  cannot be ended manually — the field is genuinely stopped. The banner always
  names its source (timing feed or manual) so the two can never be confused.

  While a neutralisation is running, the station banner shows the **fuel
  verdict for this car, pit window included**: "BOX NOW — saves N s · fill to
  X L" when the window is open and the slow field discounts the stop, "STAY
  OUT — box now adds a stop" when pitting early would cost more than the
  neutralisation saves, and "STAY OUT — fuel reaches the flag" when no stop is
  needed at all. The same verdict sits on every pit wall card, so one glance
  at the wall answers box-or-stay for all four cars at once.
- **Correct fuel reading** overrides the fuel estimate whenever you have a
  real number from the car.
- The **NEXT STOP** banner shows what runs out first — fuel, tyres, or driver
  time — and when. The **timeline** shows driven stints (solid, coloured per
  driver), the projected rest of the current stint (faded), and projected
  future stops (red ticks) to the end of the 24 hours.
- **Brakes** accrue running hours per component (pads F/R, discs F/R) against
  the life you set; meters go amber at 75 %, red at 90 %.
- **Brake sets are numbered**, one pool per component group — front discs are a
  numbered pair, rear discs another, and so are the front and rear pads. The
  brake panel shows the number on the car next to each gauge; SETTINGS → TYRES
  & BRAKES has the full rack, where you type the number written on the part,
  correct its hours, and add, remove, scrap or restore sets. A stop that changes
  a component banks its hours into the outgoing set and fits the one chosen in
  the stop planner (**SELECT PARTS…** — default: the next unused set);
  refitting a used set starts it pre-worn with its recorded hours. The wall card
  tells the crew exactly which numbers to have on the trolley.
- **Tyre sets are named** (S1, S2, …): the tyre panel shows which set is on the
  car, its laps, and how many fresh sets are left. SETTINGS → TYRES & BRAKES
  has the full set list — rename sets, correct their lap counts, add or remove
  sets. A stop with TYRES moves the current wear into the outgoing set and fits
  the set chosen in the stop planner (**FIT SET** — default: the next new set);
  refitting a used set starts it pre-worn with its recorded laps, so the wear
  meter always reads total laps on the rubber. The wall card tells the crew
  exactly which set to have ready.
- **Tyre life is a distance** (SETTINGS → WEAR & PIT, default 300 km): laps come
  from the track length, so the same figure travels between circuits and the
  settings page states the conversion ("300 km = 75 laps at 4 km").
- **Mileage rides on the set**, banked lap by lap rather than at the stop, and
  split by how it was driven: total kilometres and the part run under a
  neutralisation. Yellow kilometres are far gentler on the rubber, so at the
  flag the split is what says whether a 280 km set is worn out or has spent an
  hour crawling behind a safety car. UNDO LAP takes the mileage back too.
- **KEEP or SCRAP, asked at the stop**: when a set comes off, the station shows
  what it banked (laps, km, green/yellow split, % of life) and asks. The app
  offers an opinion — scrap past 90 % of life — but never decides. Scrapping
  asks for a reason (worn out / flat spot / damage / wrong compound), which is
  also the confirmation step; a scrapped set disappears from FIT SET and is
  never chosen by the app, until RESTORE brings it back. The set on the car
  cannot be scrapped until it comes off.
- **Drive-time regulations** (event settings, on the pit wall): max drive time
  in any rolling 6 h window, max total drive time, and minimum rest between
  stints — each enforced only when set. The Drivers panel shows every driver's
  legality live (time in window / total / rest still needed), drivers who may
  not take the next stint are marked in the stop planner's driver list, and
  the current driver's remaining legal seat time joins fuel/tyres/stint time
  as a pit limit ("DRIVE LIMIT" in the NEXT STOP banner).
- **Learning from live data** (SETTINGS → FUEL): every representative green
  lap teaches the model each driver's real pace per condition, and every
  trusted fuel figure (a SET correction, a refuel to a planned level) closes
  the laps since the previous one into a real consumption sample. The panel
  shows learned pace and burn against the configured model with the drift in
  percent; **ADOPT** writes the learned figure into the driver table (or adds
  a curve point when the per-lap-time model is active). Spans polluted by a
  neutralisation, pit visit, or driver/condition change are discarded
  automatically.
- **Next pit stop** panel — the app plans the stop, the engineer changes what
  they disagree with. There is never an empty form: from lights out the panel
  carries a complete stop, recomputed every second.
  - **Three plans, one card.** Tabs for **GREEN**, **CODE 60 / FCY** and
    **SAFETY CAR**, each with when it would happen. The situation actually
    flying is marked and pre-selected until you pick a tab yourself; the other
    two keep being worked out in the background, so "what do we do if a yellow
    drops now" is already answered before it drops.
  - **The call, then the reason**: BOX NOW / BOX WITHIN N LAPS / STAY OUT /
    NO STOP NEEDED, with the arithmetic behind it in a line of plain English
    ("boxing now would add a whole extra stop (+55 s); the window opens in 6
    laps"), and the countdown that matters underneath. Under a safety car the
    panel says outright that it cannot know whether the pit lane is open.
  - **The plan in a sentence** — *box within 12:15 — fill it full, fit set 4,
    M. Voss takes over* — so what the stop *is* never has to be assembled from
    four rows in your head.
  - **Four lines, every option on screen**: FUEL (APP / FULL / TO END / SET),
    TYRES (APP / KEEP / NEW SET / SELECT SET…), DRIVER (APP / STAYS IN / each
    driver), BRAKES (APP / NONE / each component / SELECT PARTS…). Each line
    names the numbered set it will fit. Each line either **follows
    the app** — recomputed as fuel burns, tyres wear and the flag changes — or
    is **pinned** by you and held exactly there. Pinning one line never freezes
    the others.
  - **APPROVE** is the line between "the app suggests" and "we are doing this":
    one tap freezes the figures into the stop and turns the wall card green with
    your name and the time. If the plan moves materially afterwards the tick
    clears itself and both screens say so.
  - **SEND TO CREW** → the wall card goes amber ("NEXT STOP — PREPARE").
  - **BOX BOX** → the wall card flashes red ("CAR COMING IN"). That is the last
    button the engineer has to press: with live timing running, the pit-entry
    loop stages the stop and **the pit-exit loop applies it** — tank reset to
    the planned level, tyres/brakes/driver, stint recorded with the *measured*
    pit time next to the estimate, mileage banked on the set that came off, and
    that set asking to be kept or scrapped. The manual **CAR IN PIT LANE** /
    **STOP DONE — CAR RELEASED** buttons stay as the fallback for a dead feed.
- **Every stop is signed off — approved or denied, with no timer.** The moment
  one is applied, by the feed or by hand, the station asks *did it go to plan?*
  with the measured time next to the planned one, and keeps asking until it is
  answered. A stop nobody has checked is never quietly assumed to be right.
  - **WENT TO PLAN** signs it into the stint sheet with who said so and when.
  - **NO — SOMETHING CHANGED** opens the same four lines filled in with what
    was applied, for the engineer to change into what the crew actually did:
    fuel left with, which set really went on (or none), who really got in,
    which brake parts were really changed and which numbers went on them.
    **SAVE WHAT HAPPENED** moves every
    figure to match — as a delta on the state as it stands, so the laps run
    since the stop keep their fuel, mileage and wear, and a correction ten
    minutes later is as safe as one made straight away. The stint sheet is
    rewritten to the truth and marked corrected.
  - **NO STOP HAPPENED — UNDO IT** unwinds the whole thing: fuel, rubber,
    driver, seat time, wear and the sheet, back to the moment before.
- **What the app will not do by itself** — a pit-lane visit only counts as a
  stop when the car stood there longer than driving the lane takes *and* a stop
  was armed. The bar is the **drive-through time** (pit wall → SETTINGS → RACE →
  event settings): time one clean lap of the pit lane without stopping, type it
  in, and the app adds five seconds of safety. Left at 0 it works the figure out
  from lane length and speed limit, and with neither it falls back to 25 s. The
  line under the form always states the bar in force. Otherwise the station says
  what it saw and nothing is applied:
  - **PIT LANE PASS** — a drive-through or a penalty: fuel, tyres, brakes and
    the stint clock are untouched, and the armed stop stays armed. One button
    corrects it if it really was a stop.
  - **NO STOP PLANNED** — long enough to have been serviced with nothing
    planned: the app asks instead of guessing.
  - **RACE STOPPED** — a car sitting in the lane under a red flag is not a
    stop.
  - **RACE STOPPED** — a car sitting in the lane under a red flag is not a stop
    either; the numbers are left alone and the station says why.
- **📋 PLAN** (top bar) opens the stint planner. **GENERATE FROM DRIVER
  SETTINGS** builds a full-race stint plan from the driver table: stint length
  is min(max stint, a full tank at the driver's dry burn), night stints
  (21:00–06:00) only go to night-capable drivers, ⏩ double-stint drivers run
  two stints back-to-back, and seat time is balanced across the crew. The plan
  shows race time, wall-clock time, driver, laps and fuel per stint plus
  per-driver totals, and is shared to every screen. Regenerate any time after
  changing the driver table.
  - **Plan timeline**: the plan is built for the race length and start time in
    the two fields at the top — prefilled from the current session but freely
    editable. So the full 24 h race plan can be prepared (and iterated on)
    while a 30-minute practice or qualifying session is running; a plan built
    for a different timeline than the live session is labelled as such.
  - **Saved plans**: name the active plan and **SAVE CURRENT PLAN**; LOAD makes
    a saved plan the active shared plan again. Saved plans live in the race
    state on the pit wall PC — build the race plan early, save it, run the
    short sessions, and load it back when the race starts.
  - **Plan vs actual**: once the race runs, every plan row shows what actually
    happened — the real driver (flagged when it differs), real laps, and how
    far each stop landed from the plan (Δ end). A headline line gives the
    current drift ("12:40 behind plan"), and the main timeline draws amber
    markers at the planned stops next to the red projected ones.
  - **REPLAN REST FROM NOW** keeps the driven stints exactly as they happened,
    projects the running stint to its limiting factor, and regenerates only
    the remainder — seat-time balancing seeded with the real totals, so a
    schedule wrecked by an early FCY or a long stop is rebuilt in one press.
  - **Stint sheet**: below the plan, every driven stint as a lap-timed record —
    driver, start, length, laps, best/average lap (in/out laps excluded), fuel
    used, real L/lap, and the tyre set it ran on — with per-driver rollups.
    It fills itself from the live timing feed (or manual lap times).
- **⚙ SETTINGS** (top bar) opens the car settings page, organised in tabs
  (CAR / FUEL / WEAR & PIT / DRIVERS / PRESETS / CONNECTION / DISPLAY):
  - **Car information**: name, number, make, model — shown on the pit wall too.
  - **Fuel consumption model**: per-driver average (the driver table) today; a
    per-driver-per-lap-time model is prepared for when live timing arrives.
  - **Fuel & lap model**: tank size, burn rates and average lap per condition,
    finish margin and safety fuel level.
  - **Degradation & limits**: tyre life, tyre sets, brake pad/disc life hours
    front & rear, and how many numbered sets of each are in the rack.
  - **Driver table**: per driver — name, abbreviation, timing name, double
    stints yes/no, night yes/no, rain yes/no, and personal fuel consumption in
    dry and wet (L/lap). While a driver is in the car, their own dry/wet figure
    drives the fuel burn and every projection; 0 falls back to the car default.
    Capability flags show as ⏩ 🌙 🌧 badges in the Drivers panel. The
    **abbreviation** is the short code shown in compact readouts (empty =
    derived from the surname); the **timing name** is the driver's name exactly
    as the live timing feed prints it (a surname is enough, empty = match on
    the name). When the feed's driver text matches a roster driver, the
    standings rows for the team's cars carry the driver's code, and the NOW
    strip / pit wall cards confirm the feed agrees about who is in the car — or
    warn when it disagrees (a driver change done on the radio but never logged
    in the stop planner).
  - **Pit stop timing**: tyre change time (s) for this car's crew. The
    planner and the pit wall show the estimated stationary time for the
    planned stop (fuel ÷ refuel pump speed + tyre change, sequential) plus the
    total pit time including pit-lane loss. The PIT & FCY tab also shows the
    shared event settings read-only.
  - **FCY / Code-60 calculator**: shows the FCY lap time, the time gained per
    FCY lap versus green average pace, and the net pit-lane loss when pitting
    under FCY (a "free stop" when the gain exceeds the pit-lane loss) — from
    the track length and FCY speed in the event settings.
  - **Setup presets**: save the car's complete setup (car info, fuel model,
    wear, pit timing, driver table) under a name and load it back instantly —
    on any car. Presets are stored in the shared state on the pit wall PC, so
    every station sees the same list.
  - **Connection**: shows which pit wall PC this station is connected to
    (`ws://<ip>:<port>` and live status) and lets you change the address, port
    or car slot without going back to the start screen — APPLY & RECONNECT
    stores the new target on this PC and reconnects immediately. A station
    only ever talks to the address configured here; it never switches to
    another server by itself.
  All of it can be tuned live during the race — projections update immediately.
- The station screen **never scrolls**: on small laptop screens it switches to
  a compact layout and auto-zooms so everything always fits the window.
- **Light / dark theme** (SETTINGS → DISPLAY, on the station and the pit wall):
  AUTO (default) switches to dark 30 min before sunset and back to light 1 h
  after sunrise, computed from the track's latitude/longitude (default: Circuit
  Zolder — editable in the same tab). LIGHT and DARK force a theme. The choice
  is saved per PC, so the pit wall outside and a station in the box can differ.

## How the pit wall works

The pit wall is a **display**: after setup it normally runs untouched — the
crew only reads it, and every action (pit entry, stop done) is driven from
the car stations or the live timing feed.

Each card is a **grab list**: the parts down the side (fuel, tyres, driver,
brakes) and one column per situation — **what this car needs if a yellow drops
this second**, against the **planned green stop** and when it is due. Cells
that match say *same*, so the only thing that stands out is where the two
differ: under a splash-and-dash that is the whole message. Figures are the ones
a mechanic acts on — FULL rather than a litre count that keeps moving, the rig
figure and seconds, the set number with its mileage, the driver's name, which
brake parts and the number of each. The row that forces the next stop is marked.

Under the list, the card says whether an engineer has read the plan: *app's own
plan — not approved yet*, *approved 19:42:10 · T. Claes*, or *changed since
approval — waiting on the engineer*. The tick is set on the car station; the
wall only reports it. So the crew can lay parts out long before anything is
called, and knows exactly how much of it is committed.

Once a stop is sent the card collapses to that one work order, goes amber
("NEXT STOP — PREPARE") and then red ("CAR COMING IN"). A blue card means the
car is in the pit lane (fuel burn paused); when the stop completes the card
returns to idle and the new stint starts. The wall card's own 🅿 / ✔ buttons
exist only as a backup (e.g. a station PC dies mid-stop).

**⚙ SETTINGS** on the pit wall is organised in tabs
(RACE / LIVE TIMING / REPLAYS / BACKUPS / DISPLAY). **RACE** holds the race settings:
race name, duration (hours) and the **race start date & time**. Schedule a
start in the future and every screen shows a T–countdown; the clock and all
first stints start automatically at that moment. **START RACE** in the top bar
always starts immediately instead. Each car's make/model set on its station
appears on the wall cards automatically. The RACE tab also holds the **event
settings** — track length, FCY / Code-60 speed, pit lane speed limit, pit lane
length, pit-lane loss, refuel pump speed, max stint, and the **drive-time
regulations** (max drive per rolling 6 h, max drive total, min rest between
stints; 0 = not enforced) — values that are by nature the same for every car:
change one here and it is pushed to all four cars instantly (presets and
station patches can never override them; stations show them read-only under
PIT & FCY). From the pit lane length and speed limit
it shows how long the lane takes to drive at the limit, and how much of the
pit-lane loss that leaves for entry/exit braking and the detour — a quick sanity
check on the loss figure every other calculation depends on.

The RACE tab also holds **saved race setups**: save the race name, duration and
all event settings under a name and load them back later. Prepare the real
event's configuration during a test day, save it, and LOAD it when the race
weekend starts — the values apply immediately on every screen (the start time
is deliberately not part of a setup, so loading one can never move a running
clock).

**BACKUPS** controls crash-recovery snapshots. The live state is
already saved after every change; on top of that a timestamped backup is
written every N minutes (configurable, default 5, newest 100 kept) to
`%APPDATA%/pitwall-24h/backups/` on the pit wall PC, and **SAVE SNAPSHOT NOW**
writes one on demand — e.g. right before experimenting with settings. After a
crash or a bad mistake, open the list and **RESTORE** a snapshot — every
connected screen updates instantly and only the minutes since that snapshot
need re-entering.

**RESET** (double confirmation) clears the race but keeps every car's setup.

## Live timing

The pit wall PC can connect to the official timing feed and rebroadcast the
decoded standings to every station — the stations themselves never talk to the
internet. Configure it under **⚙ SETTINGS → LIVE TIMING** on the pit wall:

- **Timing page URL** — paste the public live timing page. Supported:
  **getraceresults.com** pages (the timekeeper id is scraped from the page,
  then the SignalR feed is followed) and **Al Kamel Systems** pages
  (`livetiming.alkamelsystems.com/<series>`; if the feed carries several
  sessions a session picker appears).
- **Direct connector (TeamStream)** — the paid Time Service team feed: enter
  the timekeeper's host, your team key and port. Standard ports are 12921
  (plain TCP) / 12922 (SSL, length-prefixed + gzip); getraceresults.com runs
  the same feed on 12961 / 12962. For these known ports plain-vs-SSL is chosen
  automatically, whatever the checkbox says. Self-signed certificates can be
  accepted with the checkbox. A wrong key shows **AUTH DENIED** and stops
  retrying; everything else auto-reconnects with backoff (5 s → 30 s).

  The TeamStream feed is passing-level (one message per timing-loop crossing),
  so the server rebuilds the full scoreboard from it: positions overall and in
  class, sector times from the track sections, best / "in lap" / 2nd best
  (laps cancelled by race control for track limits are removed again), pit
  stops with pit-lane time and stint start detected from the pit-loop
  crossings, E.T.A. from the start/finish crossing on the timekeeper's own
  clock, gaps (best-time deltas in qualifying, at-the-line deltas or laps down
  in races), the session countdown from the announced session window — with
  green/chequered inferred from it — and race-control messages (penalties,
  local yellows) as a ticker line. A new session on the same connection resets
  the board, exactly like a session change on the web feed does.

The feed status is visible everywhere: a flag/remaining-time chip in the pit
wall top bar, a summary line on every wall card, and a **Live timing** panel
on each station (position, class position, last/best lap, gap/interval,
laps/stops, driver on the feed, IN PIT). Errors and reconnect states show up
on the stations too, so anyone can spot a dead feed.

### Which session is this race?

The race data on screen belongs to **one** session, and the app remembers which
one. When the feed turns out to be showing a different session — the next race
of the weekend, another session picked from the feed's list, an app left
connected since qualifying, or a connection made to a session already under way
— nothing from the feed is allowed near the numbers until the pit wall says
which it is. A **WHICH SESSION?** strip appears under the top bar and, while it
is open, feed laps, the session clock and flags are all held (the stations show
the same warning and hand lap logging back to the crew):

- **START FRESH RACE** — the data on screen was the previous session's. Laps,
  stint history, seat time, tyre sets, learning and the clock start over (car
  setups are kept), the race clock takes the feed's session clock, and every car
  starts a fresh stint on its configured start fuel.
- **KEEP THIS RACE** — the race on screen is the real one (the feed just renamed
  or rejoined it). Nothing is cleared and the feed starts counting for it again.

Joining a session that is already running, the race clock is anchored back at
the session start, but each car's **stint** starts at the join — the crew never
inherits a stint clock or a drained tank for laps the app was not there for.
Correct the actual fuel on board from the station's **Correct reading → SET**
box once the car is on the pit wall.

### Race control messages

Race-control messages from the feed (penalties, local yellows, flag
announcements — TeamStream `smsg` and Al Kamel race-control documents) show
in a **RACE CONTROL** strip under the top bar: the newest few messages on the
pit wall, the newest three on the stations, each stamped with the time it was
issued. A new message pulses the strip briefly. **HISTORY** opens the full
timestamped session log on any screen — flag calls and penalties are
colour-coded, newest first. The log is built once on the pit wall PC (a
TeamStream reconnect replays the whole session history, so it is complete
even after a restart) and rebroadcast with the timing snapshot; a session
change clears it with the rest of the board.

### Session replays

Every live session is recorded automatically on the pit wall PC — one file per
session (`replays/` next to the app data). The recorder rotates the moment a
session change is detected, so a new session always starts a fresh file and
can never spill into the previous session's replay. Under **⚙ SETTINGS → REPLAYS** on the pit wall any file can
be reopened: the recorded feed is
re-simulated through the same timing engine and rebroadcast to every screen —
play, pause, fast-forward (up to 300×) or scrub with the slider, with the
E.T.A. columns and session clock following the replay clock (frozen while
paused). A replay takes over the timing channel and never writes laps or pit
events into the race state; close it and reconnect the feed to go live again.

**Race clock**: every screen shows one countdown — **TO GO** (a T–countdown
before a scheduled start). While the feed is live, TO GO is the feed's own
session countdown, so it always matches the official board; without a feed it
runs off the race duration and start time. A connected feed that publishes the
session length overrides the configured duration outright (the duration input
is disabled while it does) — the setting is only a pre-event guess, and the
feed shows the real session. The race clock also **starts itself** the moment
the feed's session goes live (pre-start pit-lane crossings on the way to the
grid don't trigger it), so START RACE is only needed without a feed. The
internal race clock (which drives stint
projections and fuel-to-end) is aligned with **SYNC FROM LIVE TIMING** (RACE
tab, one-shot) or **keep locked to the feed** (continuous — the clock freezes
with the official clock under red flags; the start-time input is then
feed-driven and disabled).

**Car links**: each PitWall car follows the timing entry with its own race
number; override the number in the links table if they differ. **AUTO** is on
by default: the feed drives the car's lap counter, tyre-wear laps, last-lap
time and pit-lane state (fuel-burn pause), and the station's manual lap
logging card hides while the feed is live (it returns if the feed drops).
Turn AUTO off to keep a car on manual lap logging. AUTO only counts laps
while the race clock runs, and survives a pit wall restart: a feed that was
connected reconnects automatically on boot.

**Tracker** (TRACKER tab, pit wall and stations): a live track map of Circuit
Zolder with every car as a moving dot — our four cars in the accent colour, a
pulsing ring on cars in the pit lane, and a running-order rail (position, car,
driver, sector/PIT, gap) beside the map. Clicking a dot or a rail row
highlights that car. Positions come from the getraceresults tracker feed
(`t_i`/`t_p` frames): the feed reports each loop crossing plus a speed, and
the dots dead-reckon from there exactly like the vendor's own tracker —
including the honest clamp at the next timing loop until the real crossing
arrives. The track is coloured by timing sector (S1 red, S2 yellow-green,
S3 cyan, matching the official sector map) with a badge per sector and the
boundary loops and start/finish line drawn on the map; the rail's sector chip
uses the same colours. Sector boundaries come from the feed's timing-loop
distances when a tracker feed is live, and fall back to Zolder's traced
sector fractions otherwise. On feeds without tracker data (Al Kamel), dots fall back to the running
lap clock (lap start + last lap time), which is coarser but keeps the map
alive. The circuit outline is traced from `Zolder.svg` (the feed carries no
geometry); if the start/finish anchor or running direction ever look wrong
for an event, the **CALIBRATE S/F** slider and **FLIP** button under the map
fix them per screen.

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
