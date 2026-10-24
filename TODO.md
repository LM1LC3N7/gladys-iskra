# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Smart Gateway and at least one
      meter (an IE38 and an MC ideally, one gateway with a login): test
      button, device creation, the consumption the core derives from the
      index.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real gateway (built without one)

- [ ] The answers of `/api`, `/api/devices`, `/api/measurement/<n>`,
      `/api/counter/<n>` as pyiskra reads them; the units the gateway gives
      (W or kW, the temperature unit), and whether a counter `value` is a
      number or a string.
- [ ] Whether the positions of `/api/measurement/<n>` really skip the "Right
      IR" port (pyiskra drops it before counting).
- [ ] The sign of the total active power when injecting.
- [ ] Whether the gateway answers 401 or 403 to a wrong login, and whether a
      gateway without login answers 403 to a cookie.
- [ ] The time the gateway takes for one round (2 pages per meter): the
      interval (30 s, 8 s per meter) may need tuning.
- [ ] Whether the measurements carry a time of reading: none is read today;
      a frozen meter is told only by identical values for 15 minutes.
- [ ] Whether the `value` of a REST register already includes the exponent
      of the meter (in Modbus, pyiskra multiplies by `10**exponent`).
- [ ] Whether a wrong login gives 401/403 or an HTML page in 200: the latter
      would be read again every 10 minutes with the same login, as a "wrong
      answer" (no final stop).
- [ ] Whether the MC, iMC, MT, iMT and WM1 really have no non-resettable
      register on the REST page (pyiskra declares resettable ones only).

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-iskra:0.1.0`), as
  for the sibling integrations; the Release workflow owns them from now on
  (the first patch release gives 0.1.1).
- **Reused project**: pyiskra (Iskra, the maker, MIT, 0.1.29, `main` at
  commit cd23e27), cloned read-only in `~/code/ref/lot15/pyiskra`, ported to
  JavaScript (`src/iskra/`): the REST pages, the cookie login, the right IR
  port dropped, the empty ports, the measurement formats and aliases, the
  counters by direction and unit, the supported models. The SDK stays the
  only runtime dependency. The guard (`src/guard.js`, the approved file of
  gladys-energieleser / gladys-zeversolar / gladys-imeon, `maxKw` as a
  parameter, with its tests), the store, the address parser and the pace
  come from gladys-energieleser / gladys-p1-monitor (approved). The template's
  demo files were removed with `git rm`.
- **Scope (v1)**: the REST API of the Smart Gateway only, the path Home
  Assistant users take. **Modbus TCP** (a meter reached directly, pyiskra's
  Modbus adapter) is left for later (see Ideas): when added, one Modbus
  connection at a time, bounded frames, the serial read in the same session
  as the values. The time blocks and interval measurements of pyiskra are not
  ported.
- **Read-only**: only GET requests; the gateway and the meters take no
  command.
- **External id**: `meter:<serial>` (the serial of the meter in the list of
  the gateway, checked `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$`), one device per
  meter; the gateway address is only a param. Every read checks the identity
  of each meter: the serial at its position in the list read before its
  pages AND in a second list read after them; otherwise nothing from that
  read goes to it. Another meter on a port gets its own device. An unreadable
  serial is never "another meter" (the port is not read). A serial given on
  two ports of the same list, or made of zeros only, makes those ports
  unreadable (never read, never in Discovery, status note; review r1).
- **Energy index (lot 6 rules)**: the first non-resettable register with
  direction import and an active energy unit (Wh, kWh, MWh; another unit is
  never used), its slot AND its `name` chosen once and kept in `/data`; if
  that slot later holds another kind of register or another name, the index
  waits (status note), it never switches to another register. A device
  created (recognized by the form of its external id) clears the guard and
  the chosen registers of that meter: they are chosen again at the next read
  (the new device has no history, nothing is counted twice; review r1). Only
  the IE38, IE35, IE14, WM3 and WM3M4 have non-resettable registers in
  pyiskra: the MC, iMC, MT, iMT and WM1 give no index (status note). Converted to kWh, rounded to 3 decimals, through one
  `IndexGuard` per meter, published once a minute at most; held values are
  sent as the last accepted one; the guards are in `/data` before Gladys gets
  the values. A drop is accepted by the button (a meter replaced). The margin
  is the "highest plausible power" field (100 kW by default, 1 to 2000 kW:
  IE38/WM3 meters on current transformers can measure large sites), 0.5 kWh
  slack. **Acceptance in two clicks** (review r1, the mechanism of
  gladys-autarco, approved): the first lists `{ serial, direction, from, to,
threshold }` per meter and takes nothing; the second, 3 s to 5 min later in
  the same session, takes only the meters listed whose held value still has
  the same direction, `from` (and `threshold` for a jump) and a `to` within
  the guard margin since the listing. An exact `to` is not required: a live
  meter's held value moves at every read, so an exact match would never be
  acceptable; the margin bounds what is taken to what the meter could
  measure meanwhile. A meter held after the first click is never taken. The injection (first non-resettable active export counter) is a
  plain sensor, never 0. Resettable counters are never read. No
  `publishEnergyConsumption` (tested).
- **Power**: the total active power is the only energy-sensor power, signed.
  Voltage and current per phase are energy-sensor voltage/current (V, A, as
  gladys-p1-monitor); the power per phase, the power factor and the frequency
  are plain sensors; the meter temperature is a device temperature. All the
  per-phase values without history.
- **Login**: optional, both fields or none (pyiskra sends the cookie only with
  both). Sent as pyiskra does (`Cookie: Authorization=Basic <base64>`), only
  to the configured address, never after a redirect (not followed), kept in
  a private field of the client. Plain HTTP on the LAN: the gateway offers
  nothing else (documented). A 401/403 on `/api` (the principal page) is
  final (lots 12-13): kept in `/data` as `{ address, username, salt, tag }`,
  `tag` = 8 bits of SHA-256(salt, password) (lesson 7 of lot 14: never a
  hash that brute force could reverse); no automatic retry, even after a
  restart or a save of the same login; a different address, user or
  password (tag) tries again; the test button tries once (at the pace) and
  only a success lifts it. A 401/403 on the list or on a meter page, after
  `/api` was accepted in the same read, is never final (lesson 14): the
  list is retried with the usual backoff, the meter is "not read".
- **Pace (lot 11 lessons)**: one timer, one read at a time, never two reads
  less than the interval apart (30 s, or 8 s per meter when more than 3, so
  that the states stay far below 300 a minute: about 14 values per meter and
  read, tested with 10 meters) whatever asks: a reconnection, a save, the
  Discover tab, a device created, the accept button only wait for the next
  read; the test button makes the read only when one is due, otherwise tells
  the last one; the time of the last read is written in `/data` before the
  request (at most once a minute), with the number of meters.
- **Late answers (lot 11)**: a read belongs to the session of its address and
  login; a late answer of an old session publishes nothing and sets no
  status (checked after every await, tested in the middle of a read).
- **Errors**: unreachable or wrong answer: retries 30 s doubled to 10 min
  (in memory). 429/5xx of `/api` or the list: pause in `/data` from
  Retry-After or 1 min doubled, bounded 1 min to 6 h; a reconnection keeps
  it, another address ends it. Once `/api` and the list answered, any error
  on the page of one meter (a timeout too) only skips that meter, except a
  429 (the gateway asks to wait: a pause for all); its counters failing alone
  keeps its live values. No new meter is started after 60 s
  in a round (so a round lasts about a minute, a page at most 10 s more): the
  meters left are "not read" and the next round starts with them (rotation
  in memory, review r2: none is starved). The pause and the next try count
  from the failure, not from the start of the read (review r2). The pause runs on the monotonic clock in memory
  (the wall clock only for `/data`), its rest capped to 6 h at every use.
- **Hostile answers**: 64 KiB read into one buffer allocated once, 10 s for
  the whole answer, no redirect followed, 64 ports, 16 meters, 3 phases and
  32 counters at most, every value against a strict pattern and bounds
  (`""` is never 0), only own keys read (no prototype pollution, tested).
- **Freshness** (review r1): the REST pages carry no time of reading, so a
  fingerprint (8 hex digits of a hash) of the live values of each meter and
  the wall time it last changed are kept in `/data`. Identical for 15
  minutes: the live values of that meter are no longer published (so no
  heartbeat either), status note; after a restart the same fingerprint keeps
  its age. The index is not affected (the guard sends an equal value
  without dating it again).
- **Clean stop**: waits for the read running (12 s at most) and writes
  `/data`.
- **States**: `publishChangedStates` with a 10-minute heartbeat. No scene
  event.
- **Every connection** publishes the status and the Discovery list again and
  forgets the published states. Discovery offers the meters of the last list
  (or, before the first read after a restart, the meters kept in `/data`).
- **No custom User-Agent**, no imitation: Node's own fetch.
- **Gladys version**: `>=5.2.0`, like the other energy integrations.

## Ideas

- Modbus TCP for a meter without gateway (pyiskra `adapters/Modbus.py`,
  `devices/*.py` register maps): one connection at a time, bounded frames,
  the serial read in the same session.
- The time blocks (tariff blocks) of the IE meters, as plain sensors.
- A device for the gateway itself (firmware, number of meters).
