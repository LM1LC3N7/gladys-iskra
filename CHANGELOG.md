# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Integration SDK 0.16 (no change for the devices).

## [0.1.1] - 2026-10-24

### Added

- First version: the Iskra meters behind a Smart Gateway (IE38, IE35, IE14,
  WM, MC, iMC, MT, iMT) read through the local REST API of the gateway, one
  device per meter keyed by its serial number, checked against a second list
  of meters at every read.
- Active power as the energy-sensor power; voltage and current per phase;
  power per phase, power factor, frequency and meter temperature.
- The consumption index of each meter (first non-resettable active import
  counter) as its only energy index, published once a minute at most and
  checked by a guard (never 0, a drop or a jump held until "Accept the held
  index", kept in `/data`, margin set by the "highest plausible power"); the
  injection as a plain sensor.
- Optional login of the gateway (cookie, as pyiskra), never logged; a refused
  login stops the reads, kept across restarts, lifted by a new login or a
  successful test.
- Test button that never reads faster than the pace (30 s, longer with many
  meters); pace and 429/5xx pauses kept across restarts.

### Changed

- Review r1: "Accept the held index" takes two clicks and only what the first
  listed, per meter; a meter page failing or slow only leaves that meter
  unread (no new meter after about a minute in a round, the next round starts with
  the meters left); a serial on two ports is not read; the
  register of the index is kept by position and name, chosen again when the
  device is created again; meters without non-resettable registers (MC, iMC,
  MT, iMT, WM1) are said to give no index; values frozen for 15 minutes are
  no longer sent; the 429/5xx pause runs on the monotonic clock; /data is
  written at a clean stop; the power feature is named "Active power".

[Unreleased]: https://github.com/LM1LC3N7/gladys-iskra/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-iskra/releases/tag/v0.1.1
