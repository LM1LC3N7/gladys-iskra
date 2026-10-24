# gladys-iskra

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**Iskra energy meters behind an Iskra Smart Gateway (SG)** (IE38, IE35, IE14,
WM, MC, iMC, MT, iMT), read through the local REST API of the gateway, no
cloud. Not affiliated with Iskra.

**Never tested with a real Iskra gateway**: built from the maker's Python
library [pyiskra](https://github.com/Iskramis/pyiskra) (MIT, the one Home
Assistant uses), ported to JavaScript.

- One device per meter, keyed by its serial number, checked at every read.
- Active power, voltage, current and power per phase, power factor,
  frequency and meter temperature.
- Consumption index (the first non-resettable active import register, kept
  by position and name) once a minute, as the only energy index of each
  meter, checked by a guard: never 0, a drop or a jump held until the user
  accepts it in two clicks. Only the IE38, IE35, IE14, WM3 and WM3M4 have such
  registers: MC, iMC, MT, iMT and WM1 give no index. The injection is a plain
  sensor, never billed.
- Values frozen for 15 minutes (the gateway serving an old copy) are no
  longer sent.
- Optional login of the gateway, never logged; a refused login stops the
  reads until it changes or the test button succeeds.
- Read-only. Modbus TCP (a meter without gateway) is not supported yet.

User guides: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npm run cover        # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .
```

Architecture and rules: [CLAUDE.md](CLAUDE.md). Decisions and open points:
[TODO.md](TODO.md). Releases: Actions → Release (see
[CHANGELOG.md](CHANGELOG.md)).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic of pyiskra is under
MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
