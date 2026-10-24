// -----------------------------------------------------------------------------
// The Gladys device of an Iskra meter (behind a Smart Gateway) and its
// states. Pure.
//
// External id (forever): meter:<serial>, the serial number the gateway gives
// for the meter. Feature keys (forever): see FEATURE below.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-p1-monitor and gladys-energieleser:
// - `consumption_index` (the first non-resettable active import counter of
//   the meter) is the ONLY energy-sensor / index feature of a meter: the core
//   derives the consumption and its cost from its deltas, by itself. It
//   passes the guard of src/guard.js: never 0, a drop or a jump held until
//   the user accepts it;
// - the injection (the first non-resettable active export counter) is NEVER
//   in an energy-sensor index nor `energy` (it would be billed as
//   consumption): a plain sensor, kWh in the name;
// - `power` (the total active power of the meter, signed) is the only
//   energy-sensor / power feature. The power of each phase is a plain
//   sensor, so it is never taken for it;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, V, A and kWh for energy-sensor,
//   °C for device-temperature-sensor, none for unknown (the unit is then in
//   the name).
//
// The features follow what the meter showed: the set only grows, and always
// holds the features of the created device, so a device published again
// never loses one (an "Update" in Discovery would drop its history).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT_MAX, EXTERNAL_ID_TYPE, INDEX_MAX, POWER_MAX, VOLTAGE_MAX } from './constants.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  CONSUMPTION_INDEX: 'consumption_index',
  INJECTION_INDEX: 'injection_index',
  voltage: (n) => `voltage_l${n}`,
  current: (n) => `current_l${n}`,
  phasePower: (n) => `power_l${n}`,
  POWER_FACTOR: 'power_factor',
  FREQUENCY: 'frequency',
  TEMPERATURE: 'temperature',
};

const PHASES = [1, 2, 3];

/** Every feature key, in the order of the device. */
export const ORDER = [
  FEATURE.POWER,
  FEATURE.CONSUMPTION_INDEX,
  FEATURE.INJECTION_INDEX,
  ...PHASES.map(FEATURE.voltage),
  ...PHASES.map(FEATURE.current),
  ...PHASES.map(FEATURE.phasePower),
  FEATURE.POWER_FACTOR,
  FEATURE.FREQUENCY,
  FEATURE.TEMPERATURE,
];
const KNOWN = new Set(ORDER);

/** The external ids of the meter with this serial. */
export const ids = (gladys, serial) => gladys.externalIds(EXTERNAL_ID_TYPE, serial);

const feature = (external, key, name, category, type, extra = {}) => ({
  name,
  external_id: external.feature(key),
  category,
  type,
  min: 0,
  max: INDEX_MAX,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

/** A value shown, never summed nor billed: no energy category, no unit (it is in the name). */
const plain = (external, key, name, extra = {}) =>
  feature(external, key, name, C.UNKNOWN, T.SENSOR.DECIMAL, extra);

const signedPower = { min: -POWER_MAX, max: POWER_MAX };
/** A value every read: no history unless the user turns it on. */
const live = { keep_history: false };

/** The definition of each feature key. */
const DEFINITIONS = {
  [FEATURE.POWER]: (e) =>
    feature(e, FEATURE.POWER, 'Active power', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, {
      unit: U.WATT,
      ...signedPower,
    }),
  [FEATURE.CONSUMPTION_INDEX]: (e) =>
    feature(
      e,
      FEATURE.CONSUMPTION_INDEX,
      'Consumption index',
      C.ENERGY_SENSOR,
      T.ENERGY_SENSOR.INDEX,
      { unit: U.KILOWATT_HOUR },
    ),
  [FEATURE.INJECTION_INDEX]: (e) => plain(e, FEATURE.INJECTION_INDEX, 'Injection index (kWh)'),
  ...Object.fromEntries(
    PHASES.map((n) => [
      FEATURE.voltage(n),
      (e) =>
        feature(e, FEATURE.voltage(n), `Voltage L${n}`, C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, {
          unit: U.VOLT,
          max: VOLTAGE_MAX,
          ...live,
        }),
    ]),
  ),
  ...Object.fromEntries(
    PHASES.map((n) => [
      FEATURE.current(n),
      (e) =>
        feature(e, FEATURE.current(n), `Current L${n}`, C.ENERGY_SENSOR, T.ENERGY_SENSOR.CURRENT, {
          unit: U.AMPERE,
          min: -CURRENT_MAX,
          max: CURRENT_MAX,
          ...live,
        }),
    ]),
  ),
  ...Object.fromEntries(
    PHASES.map((n) => [
      FEATURE.phasePower(n),
      (e) => plain(e, FEATURE.phasePower(n), `Power L${n} (W)`, { ...signedPower, ...live }),
    ]),
  ),
  [FEATURE.POWER_FACTOR]: (e) =>
    plain(e, FEATURE.POWER_FACTOR, 'Power factor', { min: -1, max: 1, ...live }),
  [FEATURE.FREQUENCY]: (e) =>
    plain(e, FEATURE.FREQUENCY, 'Frequency (Hz)', { min: 0, max: 1000, ...live }),
  [FEATURE.TEMPERATURE]: (e) =>
    feature(
      e,
      FEATURE.TEMPERATURE,
      'Meter temperature',
      C.DEVICE_TEMPERATURE_SENSOR,
      T.SENSOR.DECIMAL,
      { unit: U.CELSIUS, min: -60, max: 150, ...live },
    ),
};

/**
 * The device of a meter. `meter`: `{ serial, model }`; `keys`: the feature
 * keys to give it (a Set). The features are fixed when the user creates it.
 */
export function buildDevice(gladys, meter, keys, address) {
  const external = ids(gladys, meter.serial);
  return {
    name: `Iskra ${meter.model} ${meter.serial}`,
    external_id: external.device,
    features: ORDER.filter((key) => keys.has(key)).map((key) => DEFINITIONS[key](external)),
    params: [
      { name: 'gateway_address', value: address },
      { name: 'serial', value: meter.serial },
      { name: 'model', value: meter.model },
    ],
  };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The feature keys a reading of a meter shows (a value present).
 * `reading`: `{ measurements, imported, exported }` (src/app.js).
 */
export function capabilitiesOf(reading) {
  const keys = new Set();
  const add = (key, value) => isNumber(value) && keys.add(key);
  const m = reading.measurements;
  add(FEATURE.POWER, m.power);
  m.phases.forEach((phase, i) => {
    add(FEATURE.voltage(i + 1), phase.voltage);
    add(FEATURE.current(i + 1), phase.current);
    add(FEATURE.phasePower(i + 1), phase.power);
  });
  add(FEATURE.POWER_FACTOR, m.powerFactor);
  add(FEATURE.FREQUENCY, m.frequency);
  add(FEATURE.TEMPERATURE, m.temperature);
  add(FEATURE.CONSUMPTION_INDEX, reading.imported);
  add(FEATURE.INJECTION_INDEX, reading.exported);
  return keys;
}

/** The feature keys a CREATED device carries: never fewer when it is published again. */
export function capabilitiesOfDevice(device) {
  return new Set(
    (device?.features ?? [])
      .map((f) => String(f.external_id).split(':').at(-1))
      .filter((key) => KNOWN.has(key)),
  );
}

/** Keys read back from /data: known keys only. */
export const validKeys = (keys) =>
  new Set(Array.isArray(keys) ? keys.filter((key) => KNOWN.has(key)) : []);

export const union = (...sets) => new Set(sets.flatMap((s) => [...(s ?? [])]));

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const state = (external, key, value, digits) =>
  isNumber(value)
    ? [{ device_feature_external_id: external.feature(key), state: round(value, digits) }]
    : [];

/** A counter: never 0 (nor below), whatever the meter said. */
const counterState = (external, key, value) =>
  isNumber(value) && value > 0 ? state(external, key, value, 3) : [];

/** The live values of a meter, every read. */
export function liveStates(external, measurements) {
  const m = measurements;
  return [
    ...state(external, FEATURE.POWER, m.power, 0),
    ...m.phases.flatMap((phase, i) => [
      ...state(external, FEATURE.voltage(i + 1), phase.voltage, 1),
      ...state(external, FEATURE.current(i + 1), phase.current, 2),
      ...state(external, FEATURE.phasePower(i + 1), phase.power, 0),
    ]),
    ...state(external, FEATURE.POWER_FACTOR, m.powerFactor, 2),
    ...state(external, FEATURE.FREQUENCY, m.frequency, 2),
    ...state(external, FEATURE.TEMPERATURE, m.temperature, 1),
  ];
}

/**
 * The indexes, once a minute at most. `consumptionIndex` is the value the
 * IndexGuard let through (undefined: not published this time). The
 * injection is a plain sensor, never published at 0.
 */
export function indexStates(external, consumptionIndex, injection) {
  return [
    ...counterState(external, FEATURE.CONSUMPTION_INDEX, consumptionIndex),
    ...counterState(external, FEATURE.INJECTION_INDEX, injection),
  ];
}
