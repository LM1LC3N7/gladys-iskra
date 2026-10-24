// -----------------------------------------------------------------------------
// The answers of the Smart Gateway REST API -> values. Pure. Ported from the
// pyiskra library (Iskra, MIT, see THIRD_PARTY_NOTICES.md),
// adapters/RestAPI.py and devices/*.py:
// - `GET /api`: `{ device: { model_type, serial_number, ... } }`, the gateway;
// - `GET /api/devices`: `{ devices: [{ interface, model, serial, ... }] }`,
//   its meters by port; the entries whose `interface` holds "Right IR" are
//   dropped BEFORE the positions are counted (SmartGateway.py), and the
//   models "Disabled" and "Not Detected" are empty ports;
// - `GET /api/measurement/<position>`: `{ measurements: { Phases: [{ U, I,
//   P, Q, S, PF, ... }], Total: { P, Q, S, PF }, Frequency, Temperature } }`,
//   each value a string "value unit", an object `{ value, unit }` or a
//   number; long names (`voltage`, `active_power`...) are aliases;
// - `GET /api/counter/<position>`: `{ counters: { non_resettable: [{ name,
//   value, unit, direction }], resettable: [...] } }`, `direction` "import"
//   or "export", `unit` Wh for active energy (helper.get_counter_type);
// - the meter models read (BaseDevice.create_device): IE38, IE35, IE14
//   (IMPACT), WM3M4, WM3, WM1 (WM), MT, iMT, MC, iMC (MeasuringCenter).
// Changed here: every value is read against a strict pattern and bounds, a
// power or an energy without a known unit is never used (never guessed: an
// energy is billed), only own keys are read, lists are bounded, nothing is
// read as 0 by default. The resettable counters are not read (a counter the
// user can reset is never an index).
// -----------------------------------------------------------------------------

import {
  CURRENT_MAX,
  INDEX_MAX,
  MAX_COUNTERS,
  MAX_LIST,
  POWER_MAX,
  VOLTAGE_MAX,
} from '../constants.js';

/** A serial number we accept: it becomes an external id, forever. */
export const SERIAL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A model name we show (it is never a free text of the user). */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;
/** The meter models pyiskra reads, matched at the start of the model (re.match). */
const SUPPORTED = /^(?:IE38|IE35|IE14|WM3M4|WM3|WM1|MT|iMT|MC|iMC)/;
/** The ports without a meter (SmartGateway.update_child_devices). */
const EMPTY_PORT = new Set(['Disabled', 'Not Detected']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A short text from the gateway, trimmed, or undefined. */
const text = (raw, max = 64) =>
  typeof raw === 'string' && raw.length <= max * 4 && raw.trim().length <= max
    ? raw.trim()
    : undefined;

/** The serial number in a field, checked, or undefined (unreadable). */
export function serialOf(raw) {
  const value = text(raw, 40);
  // Only zeros: a default number of an unset meter, never an identity.
  return value !== undefined && SERIAL.test(value) && !/^0+$/.test(value) ? value : undefined;
}

const modelOf = (raw) => {
  const value = text(raw, 32);
  return value !== undefined && MODEL.test(value) ? value : undefined;
};

/** The gateway (`GET /api`): `{ model, serial }`, undefined when it is not one. */
export function parseGateway(payload) {
  const device = own(payload, 'device');
  const serial = serialOf(own(device, 'serial_number'));
  const model = modelOf(own(device, 'model_type'));
  if (!serial || !model) {
    return undefined;
  }
  return { model, serial, firmware: text(own(device, 'sw_ver'), 32) };
}

/**
 * The list of meters (`GET /api/devices`): the ports in the positions the
 * other pages use, each `{ position, model, serial, supported }`, or
 * `{ position, empty: true }`, or `{ position, unreadable: true }` (a port
 * whose serial cannot be read: never another meter). Undefined when it is
 * not a list of meters.
 */
export function parseDevices(payload) {
  const list = own(payload, 'devices');
  if (!Array.isArray(list) || list.length > MAX_LIST) {
    return undefined;
  }
  const ports = [];
  for (const entry of list) {
    if (!isObject(entry)) {
      return undefined;
    }
    const iface = own(entry, 'interface');
    // pyiskra drops the right infrared port before counting the positions.
    if (typeof iface === 'string' && iface.includes('Right IR')) {
      continue;
    }
    const position = ports.length;
    const rawModel = own(entry, 'model');
    if (typeof rawModel === 'string' && EMPTY_PORT.has(rawModel.trim())) {
      ports.push({ position, empty: true });
      continue;
    }
    const model = modelOf(rawModel);
    const serial = serialOf(own(entry, 'serial'));
    if (!model || !serial) {
      ports.push({ position, unreadable: true });
      continue;
    }
    ports.push({ position, model, serial, supported: SUPPORTED.test(model) });
  }
  // A serial on two ports (one meter seen by two interfaces, or two meters
  // with a default number): no port of it can be told apart, none is read.
  const count = new Map();
  for (const port of ports) {
    if (port.serial) count.set(port.serial, (count.get(port.serial) ?? 0) + 1);
  }
  return ports.map((port) =>
    port.serial && count.get(port.serial) > 1
      ? { position: port.position, unreadable: true, duplicate: true }
      : port,
  );
}

const NUMBER = /^-?\d{1,12}(?:\.\d{1,9})?(?:[eE][-+]?\d{1,2})?$/;

/** A number given as a number or a strict numeric string, else undefined. */
export function numberOf(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.length <= 32 && NUMBER.test(raw.trim())) {
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

/**
 * A measurement as pyiskra parses it (RestAPI.parse_measurement): an object
 * `{ value, unit }`, a string "value unit" or "value", or a number. Returns
 * `{ value, unit }` (unit '' when none), or undefined.
 */
export function measurementOf(raw) {
  if (isObject(raw)) {
    const value = numberOf(own(raw, 'value'));
    const unit = own(raw, 'unit');
    return value !== undefined && typeof unit === 'string' && unit.length <= 8
      ? { value, unit: unit.trim() }
      : undefined;
  }
  if (typeof raw === 'string') {
    if (raw.length > 48) {
      return undefined;
    }
    const parts = raw.trim().split(/\s+/);
    if (parts.length > 2) {
      return undefined;
    }
    const value = numberOf(parts[0]);
    const unit = parts[1] ?? '';
    return value !== undefined && unit.length <= 8 ? { value, unit } : undefined;
  }
  const value = numberOf(raw);
  return value === undefined ? undefined : { value, unit: '' };
}

/** The factor of each unit we read, to W, V, A, Hz or °C. No unit: never guessed. */
const POWER = { W: 1, kW: 1e3, MW: 1e6 };
const VOLTAGE = { V: 1, kV: 1e3 };
const CURRENT = { A: 1, mA: 1e-3, kA: 1e3 };
const FREQUENCY = { Hz: 1 };
const TEMPERATURE = { '°C': 1, C: 1, degC: 1 };
const ENERGY_TO_KWH = { Wh: 1e-3, kWh: 1, MWh: 1e3 };

/** A value read with its unit, converted and bounded; `fallback` is the unit when none is given. */
function scaled(raw, units, { fallback, min, max }) {
  const m = measurementOf(raw);
  if (!m) {
    return undefined;
  }
  const unit = m.unit === '' ? fallback : m.unit;
  const factor = unit === undefined ? undefined : units[unit];
  if (factor === undefined) {
    return undefined;
  }
  const value = m.value * factor;
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/** A field under its short name, or its long alias (RestAPI.get_measurements). */
const field = (object, short, long) => own(object, short) ?? own(object, long);

const power = (raw) => scaled(raw, POWER, { min: -POWER_MAX, max: POWER_MAX });
const powerFactor = (raw) => {
  const m = measurementOf(raw);
  return m && m.unit === '' && m.value >= -1 && m.value <= 1 ? m.value : undefined;
};

/**
 * The measurements of a meter: `{ phases: [{ voltage, current, power }],
 * power, powerFactor, frequency, temperature }`, every value optional (W, V,
 * A, Hz, °C), or undefined when it is not a measurement page.
 */
export function parseMeasurements(payload) {
  const data = own(payload, 'measurements');
  if (!isObject(data)) {
    return undefined;
  }
  const rawPhases = own(data, 'Phases') ?? [];
  if (!Array.isArray(rawPhases) || rawPhases.length > 3) {
    return undefined;
  }
  const phases = rawPhases.map((phase) => ({
    voltage: scaled(field(phase, 'U', 'voltage'), VOLTAGE, { min: 0, max: VOLTAGE_MAX }),
    current: scaled(field(phase, 'I', 'current'), CURRENT, { min: -CURRENT_MAX, max: CURRENT_MAX }),
    power: power(field(phase, 'P', 'active_power')),
  }));
  const total = own(data, 'Total');
  return {
    phases,
    power: power(field(total, 'P', 'active_power')),
    powerFactor: powerFactor(field(total, 'PF', 'power_factor')),
    frequency: scaled(field(data, 'Frequency', 'frequency'), FREQUENCY, {
      fallback: 'Hz',
      min: 1,
      max: 1000,
    }),
    temperature: scaled(field(data, 'Temperature', 'temperature'), TEMPERATURE, {
      fallback: '°C',
      min: -60,
      max: 150,
    }),
  };
}

/** The name of a register (pyiskra `counter.name`): a short checked text, or undefined. */
const REGISTER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()/+-]{0,39}$/;

/**
 * One counter: `{ direction: 'import' | 'export' | undefined, active, kwh,
 * name }`, `kwh` only for an active energy (Wh, kWh, MWh) above 0 and within
 * bounds: a register at 0 is absent, never a value.
 */
function counterOf(raw) {
  if (!isObject(raw)) {
    return { direction: undefined, kwh: undefined, active: false, name: undefined };
  }
  const rawName = text(own(raw, 'name'), 40);
  const name = rawName !== undefined && REGISTER_NAME.test(rawName) ? rawName : undefined;
  const dir = own(raw, 'direction');
  const direction = dir === 'import' || dir === 'export' ? dir : undefined;
  const unit = own(raw, 'unit');
  const factor = typeof unit === 'string' ? ENERGY_TO_KWH[unit.trim()] : undefined;
  const value = numberOf(own(raw, 'value'));
  if (factor === undefined || value === undefined) {
    return { direction, kwh: undefined, active: factor !== undefined, name };
  }
  // Wh are counted in whole units by the meter: rounded to the Wh, no float residue.
  const kwh = Math.round(value * factor * 1e6) / 1e6;
  return {
    direction,
    active: true,
    kwh: kwh > 0 && kwh <= INDEX_MAX ? kwh : undefined,
    name,
  };
}

/**
 * The non-resettable counters of a meter, in their order: `[{ direction,
 * active, kwh, name }]`, or undefined when it is not a counter page. The
 * resettable ones are never read.
 */
export function parseCounters(payload) {
  const data = own(payload, 'counters');
  if (!isObject(data)) {
    return undefined;
  }
  const list = own(data, 'non_resettable') ?? [];
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.slice(0, MAX_COUNTERS).map(counterOf);
}

/**
 * The slot of the counter a meter's index (or its injection) comes from: the
 * first non-resettable active counter of that direction. Chosen once per
 * meter and kept (src/app.js): another counter never takes its place.
 */
export function slotOf(counters, direction) {
  const slot = counters.findIndex((c) => c.active && c.direction === direction);
  return slot === -1 ? undefined : slot;
}
