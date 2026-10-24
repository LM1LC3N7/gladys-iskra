# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license.

## pyiskra (Iskramis/pyiskra)

<https://github.com/Iskramis/pyiskra>, by Iskra, the maker of the meters and
of the Smart Gateway, the library the Iskra integration of Home Assistant
uses. Version 0.1.29 (`main` at commit cd23e27, 2026-02-06).

Ported to JavaScript in `src/iskra/client.js` and `src/iskra/model.js`: the
local REST API of the Smart Gateway (`GET /api`, `/api/devices`,
`/api/measurement/<position>`, `/api/counter/<position>`, a 10-second
timeout), the login sent as the cookie `Authorization=Basic <base64>`, a 403
read as "not authorised" and a 404 as "not a REST device", the right infrared
port dropped from the list before the positions are counted, the empty ports
("Disabled", "Not Detected"), the measurement formats (a "value unit" string,
an object `{ value, unit }` or a number; short names `U`, `I`, `P`, `PF` and
their long aliases), the counters by direction and unit (active energy in
Wh), and the meter models read (IE38, IE35, IE14, WM3M4, WM3, WM1, MT, iMT,
MC, iMC). The test answers in `test/fixtures/iskra.js` are shaped after what
the library reads. Changed here: values are read against strict patterns and
bounds, a power or an energy without a known unit is never used, only the
non-resettable counters are read, the identity of each meter is checked
against a second list of meters in each read. The Modbus TCP/RTU adapters,
the time blocks and the interval measurements of the library are not ported.

Its license, reproduced as it appears in the repository:

```
MIT License

Copyright (c) 2025 Iskra

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-energieleser, gladys-p1-monitor

The plausibility guard of the billed index (`src/guard.js`, with its tests),
the `/data` store (`src/store.js`), the address parser (`src/config.js`), the
bounded HTTP read and the pace of the reads come from the sibling
integrations [gladys-energieleser](https://github.com/LM1LC3N7/gladys-energieleser)
and [gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor), same
project, Apache-2.0.
