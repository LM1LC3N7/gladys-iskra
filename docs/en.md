# Iskra

Unofficial integration, not affiliated with Iskra. It reads the Iskra energy
meters connected to an **Iskra Smart Gateway (SG)**, through the local REST
API of the gateway: no cloud, no account, nothing sent to the gateway but
read requests (GET), one round every 30 seconds at most.

**Never tested with a real Iskra gateway**: it was built from the maker's own
Python library (pyiskra, the one Home Assistant uses). Feedback welcome.

## Supported meters

The meters the library reads behind a Smart Gateway: IE38, IE35, IE14
(IMPACT), WM3M4, WM3, WM1, MC, iMC, MT, iMT (Measuring Centres). Other models
listed by the gateway are named in the status and not read. A meter reached
directly over Modbus TCP, without the gateway, is not supported yet.

## What you get

One device per meter, named after its model and serial number
(`Iskra IE38MD 41000001`), with the values the meter gives:

| Feature                      | Kind                               |
| ---------------------------- | ---------------------------------- |
| Active power (see below)     | energy sensor, W                   |
| Consumption index            | energy index, kWh                  |
| Injection index (kWh)        | plain sensor                       |
| Voltage L1, L2, L3           | energy sensor, V, no history       |
| Current L1, L2, L3           | energy sensor, A, no history       |
| Power L1, L2, L3 (W)         | plain sensor, no history           |
| Power factor, frequency (Hz) | plain sensor, no history           |
| Meter temperature            | device temperature, °C, no history |

- The **consumption index** feeds the Gladys energy monitoring: Gladys
  derives the consumption and its cost from it. It comes from the first
  non-resettable counter of active energy imported by the meter (chosen the
  first time the meter is read, then kept). It is published once a minute at
  most and checked first: never 0; any drop, even of 1 Wh, or a jump larger
  than the meter could have measured (the "highest plausible power" of the
  configuration, 100 kW by default, over the time since the last value) is
  **held back** (the last accepted value is sent again) and shown in the
  integration status. If it is right (a new meter, a long outage), click
  **Accept the held index**: exactly the values shown are taken. Saving the
  configuration never accepts them.
- The **injection** (the first non-resettable counter of active energy
  exported) is never in the energy monitoring (it would be billed as
  consumption): a plain sensor.
- The resettable counters are not read: a counter that can be reset is never
  an index.
- The **active power** is the total of the meter, usually negative when the
  site injects (to be confirmed on a real meter).
- The live values are sent at each read, only when they change (and every
  10 minutes otherwise). The interval grows with many meters (8 seconds per
  meter, so 80 seconds with 10 meters), so that Gladys never receives more
  than it accepts.

## Setup

1. Find the IP address of the Smart Gateway (in your router, or the Iskra
   tools) and preferably give it a fixed address in your router.
2. In Gladys, open the integration, enter this address. If the web interface
   of the gateway asks for a login, enter its user name and password too;
   otherwise leave them empty. Save.
3. In the **Discover** tab, create the device of each meter.

## The login

The password is kept by Gladys in its database, never shown again, never
written in the logs. It is sent only to the address of the gateway, as the
gateway asks: in a cookie, over plain HTTP on your network (the gateway
offers nothing else). If the gateway refuses the login, the reads stop and
the status says so: correct the user name or the password and save, or click
**Test the connection** to try once more. The integration never tries a
refused login again by itself, even after a restart. To recognise "the same
login" after a restart, it keeps in `/data` only 8 bits of a salted hash of
the refused password (never the password itself).

## Buttons

- **Test the connection**: reads the gateway once when a read is due (never
  more than one every 30 seconds), otherwise tells the last read: the
  gateway, its meters, their power and index. After a refused login, it tries
  once more; only a success lifts the refusal.
- **Accept the held index**: takes the consumption indexes held back, as
  shown in the status, for every meter listed. A jump is counted at once as
  consumption; a drop bills nothing.

## When something goes wrong

- **Unreachable or wrong answer**: new try after 30 seconds, then doubled up
  to 10 minutes.
- **The gateway asks to wait (429) or fails (5xx)**: reads paused from 1
  minute to 6 hours, also after a restart.
- **One meter cannot be read** (its page refused or failing): the others go
  on, and the status names it.
- **The list of meters changes during a read**: the meter whose port changed
  gets nothing from that read. Each meter is keyed by its serial number: its
  values never go to another meter's device.
- **The counter of the index is no longer an import counter** (the counters
  were set up again on the meter): the index waits, the status says so;
  delete and create the device again to choose the counter again.

## Privacy

Everything stays on your network. The integration only sends GET requests to
the address you entered, with the login when you gave one.
