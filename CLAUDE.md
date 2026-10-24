# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the **Iskra meters behind an Iskra Smart Gateway** through the local
REST API of the gateway (`GET /api`, `/api/devices`,
`/api/measurement/<position>`, `/api/counter/<position>`, an optional login
sent as a cookie, no cloud). The pages and their fields are ported from
[pyiskra](https://github.com/Iskramis/pyiskra) (Iskra, MIT, see
`THIRD_PARTY_NOTICES.md`). Unofficial: not affiliated with Iskra.
**Read-only**: never `onSetValue`, only GET. Siblings: `gladys-energieleser`
(the structure of `src/app.js`, the store, the pace), `gladys-p1-monitor`
(the guard).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        IskraApp: the pace, identity, the indexes, login, pauses, buttons
src/iskra/client.js               the only HTTP access (GET, bounded, the login cookie, our error codes)
src/iskra/model.js                the answers -> values (pure)
src/guard.js                      plausibility of an energy index (approved shared file, pure)
src/store.js                      what /data keeps across restarts
src/devices.js                    the device of a meter, feature keys, states (pure)
src/config.js                     the address, the login, the margin, normalized
src/constants.js                  pages, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
scripts/cover.mjs                 the cover image
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys, a fake gateway, a virtual clock
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Energy monitoring**: `consumption_index` (`energy-sensor` / `index`, kWh)
  is the only index of a meter: the first non-resettable active import
  counter, its slot chosen once and kept in `/data`. It passes `IndexGuard`
  (`src/guard.js`, `max_power_kw` of the configuration, 0.5 kWh), one guard
  per meter: never 0, a drop and a jump never confirmed by repetition nor by
  time, taken only by the `accept_held_index` action in two clicks (the
  first lists per meter, the second takes only what was listed and has not
  changed since). The register is kept by slot and name; a device created
  chooses it again. The injection (export counter) is a plain sensor: never an index,
  never `energy`, never `publishEnergyConsumption`. Resettable counters are
  never read. Do not change `src/guard.js` without the same change in its
  siblings and a review.
- **Units**: only the core's (`DEVICE_FEATURE_UNITS_BY_CATEGORY`): W, V, A,
  kWh for `energy-sensor`, °C for `device-temperature-sensor`, none for
  `unknown` (the unit is in the name). A power or an energy without a known
  unit is never used.
- **The pace**: never two reads less than the interval apart (30 s, 8 s per
  meter beyond), whatever asks; the time of the last read is in `/data`.
  Never add a read path that skips `dueAt()`.
- **Late answers**: every await in a read is followed by `gone()`; an old
  session (address or login) never publishes nor sets a status.
- **Identity**: the values of a read go to the device of the serial read at
  that position in the same read, and only when the second list of the read
  gives the same serial there. An unreadable serial is never another meter.
- **The login**: only in the `Cookie` header of requests to the configured
  address (private field of the client), never in a log, a status, an error
  or `/data`. A 401/403 on `/api` is final (kept in `/data` with 8 bits of a
  salted hash of the password, never more): no automatic retry, only a new
  login or the test button (a success lifts it). A 401/403 on another page is
  never final.
- **Freshness**: a meter whose live values are identical for 15 minutes
  (fingerprint and age in `/data`) gets no live state published.
- **Pauses**: 429/5xx of the gateway pause from 1 min to 6 h, kept in `/data`
  (end capped when read back); a reconnection clears neither a pause nor a
  refusal. Any error but 429 on the page of one meter only skips that meter;
  a round lasts 60 s at most. The pause runs on the monotonic clock.
- **Never a free text of the gateway in a message** (description, location),
  never a URL in the logs.
- **External ids are forever**: `meter:<serial>`, the `FEATURE` keys of
  `src/devices.js`, the manifest keys and actions. Features only grow: a
  device published again keeps every feature it was created with.
- **The container rootfs is read-only.** Write only under `/data`:
  `src/store.js` keeps `/data/iskra-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. Never a
  `default` on a secret. `test/manifest.test.js` ties the manifest to the code.
- **User-facing text** is bilingual (English and French): runtime messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM nor control bytes (`test/encoding.test.js`, sources
  included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is not
  a bug in the code.

## Checking an answer against a real gateway

On the same LAN as the gateway (add `-b "Authorization=Basic <base64>"` when
it asks for a login):

```bash
curl -s "http://192.168.1.80/api"; echo
curl -s "http://192.168.1.80/api/devices"; echo
curl -s "http://192.168.1.80/api/measurement/0"; echo
curl -s "http://192.168.1.80/api/counter/0"; echo
```

Change the serial numbers before an answer becomes a fixture.
