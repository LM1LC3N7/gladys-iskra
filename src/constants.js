// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js) is forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * The external id of a meter: `meter:<serial>`, the serial number the Smart
 * Gateway gives for it in every list of its meters: a new IP address of the
 * gateway, or the meter moved to another port, keeps its device and history.
 */
export const EXTERNAL_ID_TYPE = 'meter';

// --- The local REST API of the Smart Gateway (as the pyiskra library reads it) -------
export const PATHS = {
  /** The gateway itself: `{ device: { model_type, serial_number, ... } }`. */
  GATEWAY: '/api',
  /** Its meters, by port: `{ devices: [{ interface, model, serial, ... }] }`. */
  DEVICES: '/api/devices',
  /** The measurements of the meter at a position of that list. */
  measurement: (position) => `/api/measurement/${position}`,
  /** The energy counters of the meter at a position of that list. */
  counter: (position) => `/api/counter/${position}`,
};

/** The library waits 10 s for an answer; so do we, the body included. */
export const HTTP_TIMEOUT = 10_000;
/** An answer of the gateway is a few KiB: more is not a Smart Gateway answer. */
export const MAX_BODY_BYTES = 64 * 1024;
/** At most this many entries in the list of meters (a gateway has a few ports). */
export const MAX_LIST = 64;
/** At most this many meters read (and offered in Discovery) per gateway. */
export const MAX_METERS = 16;
/** At most this many counters looked at per meter (an IE38 has 4 + 16). */
export const MAX_COUNTERS = 32;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** One read of every meter every 30 s at least, never faster, whatever asks for it. */
export const POLL_INTERVAL = 30 * SECOND;
/**
 * With many meters, the interval grows by this much per meter (300 states a
 * minute is the budget of Gladys: about 14 values per meter and read).
 */
export const POLL_PER_METER = 8 * SECOND;
/** The indexes are published (and their guard kept in /data) once a minute at most. */
export const INDEX_INTERVAL = MINUTE;
/** An unreachable gateway or a wrong answer: tries after 30 s, doubled up to 10 minutes. */
export const RETRY_MIN = 30 * SECOND;
export const RETRY_MAX = 10 * MINUTE;
/** HTTP 429 or 5xx of the gateway: a pause from 1 min to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The time of the last read is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** The test button answers within this delay (the manifest gives it 60 s). */
export const TEST_ANSWER_WITHIN = 45 * SECOND;

// --- Plausibility of the consumption index (the one Gladys bills) -------------------
/**
 * The margin of the guard of src/guard.js: a meter never draws more than
 * this on average between two published indexes. A configuration field
 * (`max_power_kw`) sets it, within these bounds.
 */
export const INDEX_MAX_KW_DEFAULT = 100;
export const INDEX_MAX_KW_MIN = 1;
export const INDEX_MAX_KW_MAX = 2000;
/** kWh always accepted on top of maxKw x hours (rounding, a late read). */
export const INDEX_SLACK_KWH = 0.5;
/** An index above this (kWh) is a glitch: not published. */
export const INDEX_MAX = 1_000_000_000;
/** A power above this (W), either way, is a glitch: not published. */
export const POWER_MAX = 10_000_000;
/** A voltage above this (V) is a glitch. */
export const VOLTAGE_MAX = 1_000;
/** A current above this (A) is a glitch. */
export const CURRENT_MAX = 10_000;

// --- Review r1 -----------------------------------------------------------------------
/** A round of reads never takes longer: the meters left are "not read" this time. */
export const ROUND_BUDGET = 60 * SECOND;
/**
 * The values of a meter identical for this long (voltages to 0.1 V, the
 * frequency to 0.01 Hz...): the gateway serves a frozen copy, they are no
 * longer published. Measured on the monotonic clock, kept in /data.
 */
export const FROZEN_AFTER = 15 * MINUTE;
/** "Accept the held index": the second click comes 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** A stop saves /data, then waits for the read running at most this long and saves again. */
export const STOP_WAIT = 5 * SECOND;
