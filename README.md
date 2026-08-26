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
3. **Load each car's car file** — on the station under
   **⚙ SETTINGS → CAR FILE → LOAD CAR FILE…**, or for all four from the pit
   wall under **⚙ SETTINGS → RACE → LOAD FILE** on each car's row. That is the
   whole car setup (fuel, pace, wear, drivers, tyre and brake racks) in one
   action; the files are written before the event, see
   [Car files](#car-files--the-setup-that-belongs-to-the-car).
4. On the pit wall, press **START RACE** when the race goes green. That starts
   the 24h clock and every car's first stint.

## Car files — the setup that belongs to the car

Two kinds of setting live in this app and they are easy to confuse:

- **Event settings** — track length, pit lane, refuelling rig, drive-time
  regulations. The same for all four cars, set **once on the pit wall** (RACE
  tab), pushed to every car instantly; stations show them read-only.
- **Car settings** — the tank, the burn rates, the average laps, the tyre and
  brake life, the tyre-change time, the driver line-up with their own
  consumption figures, and the tyre and brake racks. Different for every car,
  and set on the car.

A **car file** is that second list written down: one JSON file per car holding
everything that is the car and nothing that is the event, so the line between
the two is no longer something you have to remember — it is what is in the
file.

**Prepared before the event, with no pit wall running.** Start a station on any
PC and open **⚙ SETTINGS**. With no link the pages do not sit empty waiting for
a server: they fill in a **draft car** kept on that PC — car information, fuel,
pace, wear, the driver table, and the full tyre and brake racks (ADD SET and
GENERATE SETS… work exactly as they do live). An amber banner says so, so a
setup typed into the draft can never be mistaken for one sent to a car. When it
is right, **CAR FILE → SAVE CAR FILE…** writes it out.

**Loaded in one action.** On the day:

- From the car's own station: **⚙ SETTINGS → CAR FILE → LOAD CAR FILE…**.
- From the pit wall: **⚙ SETTINGS → RACE → LOAD FILE** on that car's row —
  all four cars can be set up from one seat.

Either way the pit wall applies it, so every screen lands on the same setup at
the same moment.

**What a load does not touch.** Laps, mileage, banked brake hours, seat time
and every tyre or brake set that has already run stay exactly as they are, and
the event settings are never overwritten — so a file can be loaded at 3 a.m.
to correct a wrong tank size without costing the car its race. Rack names from
the file replace only the sets nobody has run; a set that is on the car, used
or scrapped keeps its place and its mileage.

**The file itself** is plain JSON, grouped the way the settings tabs are
(`car`, `fuel`, `pace`, `wear`, `drivers`, `tyreRack`, `warmerRack`,
`brakeRack`), with a `_readme` line inside explaining itself. It can be read,
diffed and filled in in a text editor by somebody who never opens the app — a
decimal comma, a missing section or an unknown field are all handled: what is
there is read, what is not leaves the car as it is. Files are saved as
`<number>-<name>.pitcar.json`, so four of them sort sensibly in one folder.

**Presets vs car files.** A preset does the same job for a car setup but lives
inside the shared state on the pit wall PC: instant to load on any car, and it
needs a running pit wall. A car file is a file — it survives a rebuilt PC, goes
in an e-mail, and can be written the week before with nothing running at all.

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
- **What a neutralisation is worth** (automatic): a stop takes the same seconds
  whatever is flying — the car drives the same pit lane and stands still for the
  same fuel. What changes is how much track those seconds buy the *rivals*. So
  the discount on a stop is simply the time it occupies the pit lane multiplied
  by how much slower the field is going: at Code 60 (60 km/h) against a
  140 km/h green average, every second in the lane is handed back at 57%. The
  entry and exit braking is credited on top — under Code 60 the car is already
  at the pit limit, so it costs nothing. This is *not* the per-lap time the
  field drops under yellow: everybody loses that whether they stop or not.
  Because the discount scales with the length of the stop, a splash and a full
  tank get different answers, and **tyres and a driver change are discounted by
  exactly the same factor** — which is why a neutralisation is when to do
  everything at once. The station banner prices the tyre change both ways.
- **Box under yellow from N litres** (automatic): when the pit window is
  *closed*, boxing under a neutralisation buys a whole extra stop later, so it
  only pays if the fill is big enough for the discount to cover that stop. Every
  term in that comparison is track geometry and two speeds — none of it moves
  during a race — so the answer is a **fixed litre figure**, shown in the fuel
  panel. It is the standing call for a flag that has not flown yet: *"window
  shut? box under Code 60 only if we need 34 L or more."* With the window open
  the threshold does not apply — the stop was being made anyway and the whole
  discount is profit. **Both flags are shown**, because they differ far more
  than people expect: the Safety Car circulates much closer to green pace than
  Code 60 does, so it discounts a stop far less and its threshold is several
  times higher. The flag actually flying is outlined; a threshold the current
  fill already clears turns green.
- **IF A FLAG DROPS NOW** (automatic, green only): the same maths read forward.
  A neutralisation gives the crew seconds to decide, and until now the numbers
  only appeared once the board was already out — exactly when there is no time
  to read them. Under green a calm strip above the panels answers the question
  in advance: for this lap's fill, what would a Code 60 and a Safety Car each
  be worth, and what would tyres cost on top of it. It states the pit window
  with it, because that is what decides whether the discount is profit or is
  paying off an extra stop.
- **Take this one, or wait for the next?** (automatic, the cog on NEXT PIT
  STOP): the litre threshold above answers the fuel-only half of the question
  off track geometry alone. It cannot answer the other half — if we let this
  flag go, how likely is another before the tank forces us in at full green
  cost? That depends on how often cautions actually fall here, which is a
  measured number and the one input none of the maths above has. So the card
  ranks **four plans** — stay out, fuel only, tyres only, fuel and tyres — by
  rolling each of them forward over many stint cycles and comparing **time to
  complete the same lap count**, averaged over exactly one fuel cycle so the
  answer is not just measuring who happens to have refuelled most recently.
  Later stops are priced as an expected value: a caution may well be running by
  the time they come due, and how likely that is is the thing being tested.
  - The answer is a **break-even rate** — how frequent cautions would have to
    be before waiting beats taking the one that is out — compared against the
    crew's own figure. Zolder 2019–2025 measured **0.639 usable Code 60 per
    hour**, counting flags of four minutes or longer, and that is the default.
  - A winner that beats the runner-up by **less than 2 s** is a tie the
    arithmetic happened to break, not a decision. The card says **LINE BALL**
    and leaves it to the crew, rather than reading as a call it has not earned.
  - **How long the flag runs decides most of it.** The discount is earned
    second by second while the field is crawling, so a caution that goes green
    with the hose still connected pays for part of the stop and no more — and
    the car has to reach pit entry first, which eats into it before a drop of
    fuel goes in. On the Zolder record about a quarter of flags are short
    enough that a fuel stop **never** pays, at any point in a stint. *Caution
    length (min)* is therefore a figure in its own right: 7.1 min, the median
    usable Code 60, is the default.
  - Two more figures live behind the same cog. *Stop slack (s)* adds time to
    every stop the call prices — an overshot box, a sticky coupling, traffic in
    the lane — so wind it up and see whether the call still stands when the
    stop goes wrong. Note which way it moves the answer, because it is the
    reverse of what it sounds like: standing still in the lane is discounted
    like every other second of a stop, so every plan pays the slack at every
    stop it makes and only the one taken under the flag gets it cheap. A
    sloppier stop makes the flag worth **more**, not less. It moves this call
    only, never the measured pit-lane and E.T.A. figures. *Pit lane fuel (L)* is what the car burns
    driving the lane, derived from the neutralised burn across the lane's share
    of a lap when left at 0.
  - **WHEN IT STARTS TO PAY** (the graph, same cog): the same comparison swept
    across the whole stint — seconds gained against staying out at every minute
    of it, one line per option, with the car's own position marked. Above the
    dashed line the stop is ahead; inside the shaded band it is ahead by less
    than 2 s. It answers the question the verdict alone cannot: when the call
    is *stay out*, how long the crew is waiting for that to change. Each flag
    is drawn on its own, and the numbers are one tap away for anyone who would
    rather read them than look at them.
  - The proposed **CODE 60** and **SAFETY CAR** stops carry the result: the
    head names the work the flag is actually worth doing — *BOX NOW · FUEL +
    TYRES*, *BOX NOW · FUEL ONLY* — and a stop that does not pay yet says which
    minute of the stint it starts to.
- **Low fuel warning**: once the tank is down to the warning threshold
  (SETTINGS → FUEL → *Low-fuel warning (L)*, default 15 L, 0 = off) a banner
  appears with the liters, laps and time left above the safety level — amber
  at the threshold, red and flashing at half of it. The threshold is set in
  liters because that is what the crew reads off the rig and types into
  CORRECT FUEL READING; a lap figure would quietly move every time the burn
  rate did. It is muted while the car is already in the pit lane and when the
  maths says the fuel reaches the flag anyway.
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
- **Brakes** accrue running hours per part (pads F/R, discs F/R) against
  the life you set; meters go amber at 75 %, red at 90 %.
- **Pads are bedded onto discs, and that pair is a KIT.** A pad set bedded onto
  a disc set is what the car runs and what a stop calls for by name — F1, F2,
  R1 — with the two part numbers as the detail underneath. The brake panel is
  read by axle under the name of the kit on it; SETTINGS → TYRES & BRAKES shows
  the rack the way the crew lays it out: one board per axle, every disc set a
  line of its own with the pads bedded onto it indented underneath, and the pad
  sets that are bedded onto nothing collected under **AVAILABLE PADS**.
  **BED PADS…** on a disc line (or **BED ONTO…** on a free pad set) marries a
  pair and names the kit; **UNBED** takes it apart. A kit is one-to-one: bedding
  pads that already belong to another disc set moves them, and the kit that is
  on the car cannot be taken apart on paper while those two parts are running
  together. Whatever comes out of the box is a kit — fit fresh pads onto the
  discs already on the car and the rack re-ties itself to match.
- **Brake sets are numbered**, one pool per part group — front discs are a
  numbered pair, rear discs another, and so are the front and rear pads. You
  type the number written on the part, correct its hours, and add, remove,
  scrap or restore sets. Scrapping half a kit dissolves it: nothing stays bedded
  onto a part that is in the bin. **GENERATE SETS…**
  writes whole pools at once: tick the component groups a delivery covers, then
  give a naming pattern, a starting number and a count. `[P]` is each group's own
  prefix (PF, PR, DF, DR), so one pattern names the lot — `[P][#]` → PF7, PR7,
  DF7, DR7, and `[P] [##]` → PF 07. The starting number continues the series
  already on the rack, every pool previews on its own line, a part number that
  already exists is flagged instead of duplicated, and **REPLACE UNUSED** sweeps
  out the sets nobody has run while the parts on the car, every used set and
  every scrapped one stay with their hours. A stop that changes
  a part banks its hours into the outgoing set and fits the one chosen in
  the stop planner (**SELECT PARTS…** — kits for an axle having its kit changed,
  free pad sets for one only having pads); refitting a used set starts it
  pre-worn with its recorded hours. Left to the app, a kit change takes the
  first made-up kit nobody has run, and a pads-only change takes a pad set that
  is bedded onto nothing — so a kit already married up is never robbed of its
  pads. The wall card tells the crew the kit and exactly which numbers to have
  on the trolley.
- **Tyre sets are named** (S1, S2, …): the tyre panel shows which set is on the
  car, its laps, and how many fresh sets are left. SETTINGS → TYRES & BRAKES
  has the full set list — rename sets, correct their lap counts, add or remove
  sets. **GENERATE SETS…** writes the whole allocation in one go: a naming
  pattern (`[#]` is where the number goes, `[###]` pads it to 001), a starting
  number and a count, with a live preview of the names before anything is
  committed — so the list reads the way the stickers on the rubber do
  (`S[#]_GVP` → S1_GVP, S2_GVP…). A name already in the pool is flagged instead
  of silently doubled, and **REPLACE UNUSED** sweeps out the sets nobody has run
  yet (the placeholder S1–S12 a car starts with) while the set on the car, every
  used set and every scrapped one stay, mileage and all. A stop with TYRES
  moves the current wear into the outgoing set and fits the set chosen in the
  stop planner (**FIT SET** — default: the next new set);
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
- **Tyre warmers** — the icon at the top right of the station's TYRES & BRAKES
  card. The rack says what rubber the team owns; the warmers say what is ready
  to go on. Clicking it opens the boxes: **+ / −** sets how many warmers the
  garage has (0 for a team that runs without, up to 12), and each one has a
  picker holding at most one set out of that same stock. The badge on the icon
  reads how many are loaded (2/4), and turns amber when the set the next stop
  is fitting is in none of them — which is the question the crew actually asks
  at 03:00. The rules are the ones the garage already works to: a set is only
  ever in one place (carrying it to another box moves it), the set on the car
  is never in a warmer, a scrapped set comes straight out of the one it was in,
  and a set fitted at a stop leaves its box the moment it goes on. The count and
  the names travel in a car file; what is in them is race data and does not.
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
  - **Three separate plans, one card.** Tabs for **GREEN**, **CODE 60 / FCY**
    and **SAFETY CAR**, each with when it would happen. They are three
    different work orders, not one plan shown three ways: each keeps **its own
    pinned lines and its own approval**, so the code 60 plan can say "full
    tank, four tyres, driver out" while the green plan next to it says "splash
    and go" — and both stand ready at the same time. The situation actually
    flying is marked and shown by default; tapping another tab **holds** the
    card there so that plan can be written in advance (a strip says so, and
    the SEND button names the plan it would ship), and tapping the same tab
    again — or **FOLLOW THE RACE** — hands the card back to the flag. A corner
    dot on each tab says how far that plan has been written: amber for lines
    pinned, green for approved, red for approved-then-moved.
    **CLEAR** wipes only the plan on screen; the other two stand.
    A crew that will never split its safety car plan from its code 60 one can
    **take a situation off the wall** — a line under the tabs says whether the
    wall carries a column for the plan on screen, and takes it down or puts it
    back in one tap (the planned green stop always shows; it is what the card
    is built around). Only the column goes: the plan still stands, still
    approves, and the wall shows it the moment that flag is actually out.
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
    driver), BRAKES (APP / NONE / F PADS / F KIT / R PADS / R KIT / SELECT
    PARTS…). Brakes are called by axle: **PADS** onto the discs already on the
    car, or the whole **KIT** — discs never come off without the pads bedded to
    them, so a disc change is a kit change. Each line names the kit and the
    numbered parts it will fit. Each line either **follows
    the app** — recomputed as fuel burns, tyres wear and the flag changes — or
    is **pinned** by you and held exactly there. Pinning one line never freezes
    the others, and never touches the other two situations' plans.
  - **APPROVE** is the line between "the app suggests" and "we are doing this":
    one tap freezes the figures into the stop and turns the wall card green with
    your name and the time. It signs off **the situation on screen** — each of
    the three carries its own tick, so a code 60 plan can be approved and ready
    hours before the yellow that needs it. If that plan moves materially
    afterwards its own tick clears itself and both screens say so.
  - **SEND TO CREW** → the wall card goes amber ("NEXT STOP — PREPARE").
  - **BOX BOX** → the wall card flashes green ("CAR COMING IN"). That is the last
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
    fuel left with, which set really went on (or none), who really got in, and
    per axle whether nothing, the pads or the whole kit was changed — with the
    numbers that really went on.
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
  (CAR / FUEL / WEAR & PIT / DRIVERS / CAR FILE / CONNECTION / DISPLAY). With
  no pit wall to talk to, these pages edit this PC's **draft car** instead of
  the live one and an amber banner says so — which is how a car file is built
  before the event:
  - **Car information**: name, number, make, model — shown on the pit wall too.
  - **Fuel consumption model**: per-driver average (the driver table) today; a
    per-driver-per-lap-time model is prepared for when live timing arrives.
  - **Fuel & lap model**: tank size, burn rates and average lap per condition,
    finish margin and safety fuel level.
  - **Degradation & limits**: tyre life, tyre sets, brake pad/disc life hours
    per axle, and how many numbered sets of each are in the rack.
  - **Tyre sets**: the named pool — add one set, or GENERATE SETS… for the whole
    allocation from a naming pattern, a starting number and a count.
  - **Brake rack**: the axle boards — disc sets with their bedded pads nested
    under them, free pad sets underneath — where kits are made, named and taken
    apart, with the same GENERATE SETS… across as many part groups as a delivery
    covers ([P] = the group's prefix).
  - **Driver table**: per driver — name, abbreviation, timing name, double
    stints yes/no, night yes/no, rain yes/no, and personal fuel consumption in
    dry and wet (L/lap). While a driver is in the car, their own dry/wet figure
    drives the fuel burn and every projection; 0 falls back to the car default.
    Capability flags show as ⏩ 🌙 🌧 badges in the Drivers panel. The
    **abbreviation** is the short code shown in compact readouts (empty =
    derived from the name: first letter of the first name + first two of the
    last, "Roman Rusinov" → RRU — the field's placeholder proposes it); the
    **timing name** is the driver's name exactly
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
  - **FCY / Code-60 calculator**: shows the FCY lap time, the per-lap time the
    whole field drops under it, the discount an actual stop earns, and what the
    stop nets out at — from the track length, the FCY speed and the pit lane
    legs in the event settings. The per-lap delta and the discount are separate
    figures on purpose: the first is what the neutralisation does to the race,
    the second is what pitting under it does for you.
  - **Car file**: SAVE CAR FILE… writes everything that belongs to this car —
    car info, fuel model, pace, wear limits, tyre-change time, the whole driver
    table with its fuel curves, and the tyre and brake racks by name — to one
    JSON file; LOAD CAR FILE… reads one back. Event settings are deliberately
    not in it, and loading never touches laps, mileage, seat time or any set
    that has run. See [Car files](#car-files--the-setup-that-belongs-to-the-car).
  - **Setup presets**: the same setup saved under a name instead of to a file,
    loadable instantly on any car. Presets are stored in the shared state on the
    pit wall PC, so every station sees the same list — and so they need a
    connected station, where a car file does not.
  - **Connection**: shows which pit wall PC this station is connected to
    (`ws://<ip>:<port>` and live status) and lets you change the address, port
    or car slot without going back to the start screen — APPLY & RECONNECT
    stores the new target on this PC and reconnects immediately. A station
    only ever talks to the address configured here; it never switches to
    another server by itself.
  All of it can be tuned live during the race — projections update immediately.
- **Page size** (SETTINGS → DISPLAY, on the station): how large this station
  draws itself. The strategy view holds every figure for the car at once and
  used to be shrunk until all of it fitted the window whatever that did to the
  type — 77% on a 1920×1080 screen, 62% on a 1600×900 laptop, which puts the
  small labels under 9 px. **AUTO** (default) now stops shrinking at 90% and
  lets whatever is left over scroll, and it enlarges the page on a screen with
  room to spare (a 4K panel gets ~155%, where the old 100% ceiling just drew
  the same design in smaller millimetres). Only the two columns scroll, and
  each on its own: the flag bar, the race-control strip, the FCY and low-fuel
  banners and the NOW row stay put, and a long left column never pushes the
  stop card off the bottom. Drag the slider until it reads from where you sit —
  the hint says how much is below the fold and at what size it all fits, so
  drag down if you would rather have the whole page on screen. Small laptop
  screens also switch to a compact layout. Saved per PC, like the theme.
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
this second**, against the **planned green stop** and when it is due. Every
column is headed by its own flag badge in its own colour — amber **CODE 60**,
white **SAFETY CAR**, green **GREEN** — with the line under it saying when the
column applies (*if it drops*, *planned · 45:30*), so which plan a column
answers for reads before the words do. Under green the code 60 and safety car
plans get a column each as soon as the engineer has made them say different
things (while they agree they share one column, *code 60 · sc*); under an
actual neutralisation only the flag that is flying gets a column. Every cell
always states its own instruction in full — nobody reading one column has to
look sideways to learn what it asks for — and a cell that only repeats the
column beside it is simply dimmed, so where the columns *differ* is the only
thing carrying colour: under a splash-and-dash that is the whole message.
Figures are the ones
a mechanic acts on — FULL rather than a litre count that keeps moving, the rig
figure and seconds, the set number with its mileage, the driver's name, which
brake work by axle — the kit's name, then the numbers to pull off the rack. The
row that forces the next stop is marked.

**Colour on a card is the instruction, not a health score.** The board is read
by people with parts in their hands, so it uses the only two colours everybody
already reads the same way: **green means it changes** — the car comes in, that
set comes off, that driver gets out — and **red means it stays as it is** —
stay out, KEEP, STAYS IN, NO FUEL. Green cells carry a tint as well as the
figure, so what has to be fetched is what pulls the eye from across the garage;
red is text alone, because a car with nothing to change must not read as an
alarm. **Amber** never answers box-or-stay: it only warns about the answer —
the stop is sent and the crew should prepare, the fuel is running low, the row
that forces the next stop, or a change that is asked for with nothing free in
the rack to do it with. **Blue** is the stop already happening (car in the pit
lane). The words always say it too, so nobody has to know the code.

Under the list, the card says whether an engineer has read the plan the stop
would actually follow — the flag that is flying, or the plan the engineer is
holding the card on — and names it: *app's own CODE 60 plan — not approved
yet*, *GREEN plan approved 19:42:10 · T. Claes*, or *GREEN plan changed since
approval — waiting on the engineer*. The tick is set on the car station; the
wall only reports it. So the crew can lay parts out long before anything is
called, and knows exactly how much of it is committed.

Nothing on a card scrolls or ends in an ellipsis: the verdict line, the
station warnings and the crew's note for the stop wrap onto a second line
instead, because the crew glances up once and has to have the whole answer.

**When more than one car is coming in, the head of each card says who goes
first.** One crew services four cars, so the moment something happens — a flag
drops, or a second stop is sent — the question stops being *is this car coming
in* and becomes *which one do we take first*. The answer sits next to the car
number, where the eye already is: **1st**, **2nd**, **3rd** *of 3 to box*, with
the car the crew can act on right now in green. It is not a guess. The order is
read straight off the same pit arrival estimate the card's own sub-line shows —
the car's position reconstructed from its last timing-loop crossing, carried
forward at green pace up to the flag and at the neutralisation speed after it —
so the car with the shortest run left to the box is the one that gets the box
first. A car already in the pit lane is at the front by definition (*in the
lane*, longest-standing first), and an estimate that has been dead-reckoning for
more than a lap without a fresh crossing is marked as the estimate it is
(*~3rd*). A car the feed cannot place is left out rather than given a made-up
slot. The badge is on screen only while two or more cars are actually inbound —
a queue of one is not an order — so its appearing is itself the news.

Once a stop is sent the card collapses to that one work order, goes amber
("NEXT STOP — PREPARE") and then flashing green ("CAR COMING IN"). A blue card means the
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
length, pit-lane loss, refuel pump speed, rig dead time, max stint, and the **drive-time
regulations** (max drive per rolling 6 h, max drive total, min rest between
stints; 0 = not enforced) — values that are by nature the same for every car:
change one here and it is pushed to all four cars instantly (presets, car files
and station patches can never override them; stations show them read-only under
PIT & FCY). The same tab's car rows carry **LOAD FILE** / **SAVE FILE**: one
car's whole setup read from or written to a car file, from the wall, for any of
the four. They start on Zolder's official figures — 4,007 km, pit IN to pit
OUT 411 m, intermediates at 1376,4 m and 2864,6 m from a start line at offset
0 — so a fresh race is already measuring the right lap; type over them for any
other circuit. From the pit lane length and speed limit
it shows how long the lane takes to drive at the limit, and how much of the
pit-lane loss that leaves for entry/exit braking and the detour — a quick sanity
check on the loss figure every other calculation depends on.

Below it, **pit lane legs** breaks the lane into the parts a stop actually
drives, timed at the pit speed limit: *pit entry → fuel rig*, *rig → box* and
*box → pit exit*. Two more derive from those unless the lane makes them differ
(*rig → exit*, for a stop that rejoins without going to the box, and *entry →
box*, for a stop that takes no fuel), and a **minimum stop time** applies a
series rule that holds the car between the pit-in and pit-out lines — work that
fits inside it is free. A worked example under the fields shows what a full fill
occupies the lane for, with and without a tyre change. Leave every leg at 0 and
a stop is priced as its stationary work alone, exactly as before.

Each car's **average green speed** (station SETTINGS → FUEL, 0 = derive it from
that car's average lap) is the yardstick all of this is measured against: it is
a property of the car's pace rather than the track, so it lives per car.

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

**DISPLAY** holds the light/dark theme (as on a station) and the **board
size** — how large the four cards, the flag strip, the race-control strip and
the tracker are drawn on this screen. A 4K TV does not make the board more
readable by itself: it draws the same design in smaller millimetres. The whole
board scales as one, so a larger setting is the same card seen from closer,
not the same card with the type swapped, and it resizes while the slider
moves — set it by standing where the crew stands and dragging until it reads.
**AUTO** (default) blows the board up to fill the window, which is the right
start for a TV in the box; a laptop at the desk wants 100%. The slider stops
where four whole cards stop fitting on this screen, and a board scaled near
that limit gives back its padding, then the detail lines under each
instruction, rather than clipping the bottom of a work order. Saved per PC,
like the theme.

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

  Some timekeepers export more of the underlying timing record than the feed
  we first met did. Where they do, it is used in preference to the
  reconstruction above: an explicit **session status**
  (`GREEN`/`YELLOW`/`RED`/`CODE60`/`FINISH`) becomes the flag outright instead
  of being inferred from the clock — a race held under red past its scheduled
  end then stays red rather than turning chequered; a **heat type** (`R`/`Q`)
  decides race-vs-qualifying scoring instead of guessing from the session
  name; and a per-loop **allow-fastest** flag says which crossings may score a
  best lap. Any of these may arrive as an XML attribute rather than an
  element, and both are read. Whatever else a timekeeper sends that the app
  does not use is named once in the connection log, so an unfamiliar export
  can be spotted from the log rather than a packet capture.

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

### When the feed dies mid-race

The timing link is somebody else's network and it will not ask before it goes.
Losing it costs the app nothing that cannot be done by hand, and it hands the
work back on its own — no setting to find, no mode to switch.

- **The race keeps running.** The clock is the app's own again (it never
  freezes with the feed), the flag falls back to whatever the pit wall calls
  by hand, and a manual FCY / SC / RED made before the drop is kept. The
  reconnect is automatic, 5 s backing off to 30 s, and the top bar says
  **FEED RETRYING** the whole time.
- **Lap logging comes back by itself.** The **+ LAP** card returns on every
  station within a second and the Inputs panel says `manual · N laps` instead
  of `feed · N laps`.
- **The stop is markable by hand at any point.** **CAR IN PIT LANE** appears
  wherever it is needed — not only on a stop that was boxed — so an unplanned
  arrival (damage, a puncture, a driver called in off-plan) is logged in one
  press, and **STOP DONE — CAR RELEASED** closes it.
- **The laps run during the outage are put back.** Lap *events* are lost with
  the link, but the lap *number* the feed publishes is not: it is tracked per
  car, held across the outage, and the difference when the feed returns —
  less whatever the crew logged by hand in the meantime, so nothing is ever
  counted twice — goes back onto the counters and the tyre. The station says
  what happened (`3 laps put back — run while the timing feed was down`), and
  a discrepancy too large to trust is reported rather than applied.
- **The count is settable outright.** **Correct total laps → SET** on the
  station is the floor under all of it, feed or no feed: the stint, the tyre
  on the car and its banked mileage all move with the number.
- **The start time is editable again.** Ticking *keep locked to the feed* no
  longer greys the field out once the feed is gone — the lock stays on and
  resumes when the link is back.

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
distances when a tracker feed is live, and fall back to Zolder's official
intermediates otherwise — Int 1 at 1376,4 m and Int 2 at 2864,6 m of 4007 m,
straight off the circuit's own track map. On feeds without tracker data (Al Kamel), dots fall back to the running
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
npm run test:brakes  # drives the brake rack board on a real station, writes test/brake-rack*.png
```

**Two copies on one PC** (a station beside the pit wall — demos, test days):
the second copy needs its own profile folder or the two instances fight over
the same localStorage. `test\demo-station.cmd` starts one set up that way, or
set `PITWALL_USER_DATA=<dir>` before `npm start`.

**Demoing the app**: `node test/demo-setup.mjs` (against a running pit wall)
configures the four cars as the LMP2 entries of the recorded
getraceresults demo session and links them to its race numbers, so a session
replay (SETTINGS → REPLAYS) drives standings, tracker and driver-matching for
a realistic, pausable presentation. The presenter script lives in
`docs/demo-run-of-show.html`.

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
