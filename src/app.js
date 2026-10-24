// -----------------------------------------------------------------------------
// The integration itself: the Iskra Smart Gateway read through its local REST
// API, one Gladys device per meter behind it, the consumption index of each
// meter checked by its own guard and published once a minute, the pauses and
// the refused login kept in /data, the test and accept buttons. index.js only
// wires the SDK handlers to it. Read-only: nothing is ever sent to the
// gateway but GET requests.
//
// One read = the gateway (`/api`, the principal page: a login refused there
// is final), its list of meters, the measurements and counters of each
// supported meter, then the list again: a meter whose serial is not the same
// in both lists at its position gets nothing from this read (its port was
// swapped meanwhile). The values of a read always go to the device of the
// serial read in that read, never to another one.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data). Structure taken from
// gladys-energieleser (approved).
//
// A read belongs to its session (the client of one address and login): when
// they change, a late answer of the old one publishes nothing and sets no
// status (checked after every await).
//
// Two clocks: `now` (wall clock) dates the indexes and what /data keeps;
// `monotonic` paces the reads, so that a wall clock set back never stops them.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { isComplete, normalizeConfig } from './config.js';
import {
  ATTEMPT_SAVE_EVERY,
  INDEX_INTERVAL,
  INDEX_SLACK_KWH,
  MAX_METERS,
  PAUSE_MAX,
  PAUSE_MIN,
  POLL_INTERVAL,
  POLL_PER_METER,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  FEATURE,
  buildDevice,
  capabilitiesOf,
  capabilitiesOfDevice,
  ids,
  indexStates,
  liveStates,
  round,
  union,
  validKeys,
} from './devices.js';
import { GatewayClient, GatewayError } from './iskra/client.js';
import { SERIAL, slotOf } from './iskra/model.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

/** At most this many index states kept in /data (one per meter seen). */
const MAX_KEPT_INDEXES = 64;
/** At most this many meters kept in /data. */
const MAX_KEPT_METERS = 32;
/** Errors on the page of one meter that leave the other meters read. */
const METER_ONLY = new Set([
  'refused',
  'not_found',
  'server',
  'http',
  'not_json',
  'unknown_answer',
]);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isSlot = (value) => Number.isInteger(value) && value >= 0 && value < 64;

/**
 * The tag of a refused password: 8 bits of a salted hash, never more (a
 * short password must not be found back from /data by brute force). Two
 * passwords share it once in 256: the test button then tries anyway.
 */
export const tagOf = (salt, password) =>
  createHash('sha256').update(`${salt}\u0000${password}`, 'utf8').digest()[0];

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** A pause read back from /data: `{ until, count, code, status }`, its end capped from now. */
function validPause(pause, now) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    (pause.code !== 'rate_limited' && pause.code !== 'server')
  ) {
    return undefined;
  }
  return {
    until: Math.min(pause.until, now + PAUSE_MAX),
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : null,
  };
}

/** The refused login read back from /data: `{ address, username, salt, tag }`. */
function validRefused(refused) {
  return refused &&
    typeof refused.address === 'string' &&
    typeof refused.username === 'string' &&
    typeof refused.salt === 'string' &&
    /^[0-9a-f]{32}$/.test(refused.salt) &&
    Number.isInteger(refused.tag) &&
    refused.tag >= 0 &&
    refused.tag < 256
    ? {
        address: refused.address,
        username: refused.username,
        salt: refused.salt,
        tag: refused.tag,
      }
    : undefined;
}

/**
 * The list of meters. Refused while the gateway page was accepted in the
 * same read: never a refused login (no final stop), a failure retried later.
 */
async function listOf(client) {
  try {
    return await client.devices();
  } catch (err) {
    if (err instanceof GatewayError && err.code === 'refused') {
      throw new GatewayError('list_refused', { status: err.status });
    }
    throw err;
  }
}

/** Plain objects under string keys only (no prototype key). */
function plainEntries(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return [];
  }
  return Object.entries(object).filter(
    ([key, value]) =>
      key !== '__proto__' && value && typeof value === 'object' && !Array.isArray(value),
  );
}

/** The meters kept in /data: `serial -> { serial, model, keys, importSlot, exportSlot }`. */
function keptMeters(meters) {
  const kept = new Map();
  for (const [serial, value] of plainEntries(meters)) {
    if (!SERIAL.test(serial) || typeof value.model !== 'string' || value.model.length > 32) {
      continue;
    }
    kept.set(serial, {
      serial,
      model: value.model,
      keys: validKeys(value.keys),
      importSlot: isSlot(value.importSlot) ? value.importSlot : undefined,
      exportSlot: isSlot(value.exportSlot) ? value.exportSlot : undefined,
    });
  }
  return new Map([...kept].slice(-MAX_KEPT_METERS));
}

export class IskraApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'iskra' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    clientFactory = (options) => new GatewayClient(options),
    store = createFileStore(),
    random = () => randomBytes(16).toString('hex'),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.clientFactory = clientFactory;
    this.random = random;
    /** /data: guards, meters, the pause, the refused login, the last read. */
    this.store = store;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** `{ client, discovered }` of the current address and login; replaced when they change. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;

    const kept = store.load();
    const at = now();
    this.pause = validPause(kept.pause, at);
    /** The login the gateway refused: no read until it changes or the test button succeeds. */
    this.refused = validRefused(kept.refused);
    /** The meters seen, kept so that their devices are offered at a restart. */
    this.meters = keptMeters(kept.meters);
    /** The number of meters of the last read: it sets the interval (kept for a restart). */
    this.meterCount =
      Number.isInteger(kept.meterCount) && kept.meterCount >= 0
        ? Math.min(kept.meterCount, MAX_METERS)
        : 0;
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.savedAttemptAt = this.lastAttemptAt;
    /** Monotonic time of the last read started. */
    this.lastReadAt =
      this.lastAttemptAt === undefined ? undefined : monotonic() - (at - this.lastAttemptAt);
    /** By index feature external id. */
    this.guards = new Map();
    this.guardKw = undefined;
    this.resetReads();
  }

  /** What belongs to one address: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'reading' | 'error', ... }`. */
    this.outcome = undefined;
    /** Wrong answers and unreachable gateway: retries doubled, in memory. */
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    /** The serials of the last list of meters (this session), in Discovery. */
    this.current = undefined;
    this.gatewaySerial = undefined;
    this.otherGateway = false;
    /** Monotonic time the indexes were last published. */
    this.lastIndexAt = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /** The key of what a session is: the address and the login. */
  static sessionKey(config) {
    return JSON.stringify([
      config.address,
      config.invalidAddress,
      config.login?.username ?? null,
      config.login?.password ?? null,
      config.invalidLogin,
    ]);
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || IskraApp.sessionKey(config) !== IskraApp.sessionKey(this.config);
    const addressChanged = !first && config.address !== this.config.address;
    this.config = config;
    if (this.guardKw !== config.maxKw) {
      // Another margin: the guards are built again from /data (saved first).
      await this.saveState();
      this.guards.clear();
      this.guardKw = config.maxKw;
    }
    if (changed) {
      this.session = {
        client: isComplete(config)
          ? this.clientFactory({ address: config.address, login: config.login })
          : undefined,
        discovered: false,
      };
      if (!first) {
        this.resetReads();
      }
      if (addressChanged && this.pause) {
        // Another address: a pause asked by the old one ends; the pace does not.
        this.pause = undefined;
        await this.saveState();
      }
    }
    // A login refused stands only for the same address, user and password.
    if (this.refused && !this.refusedApplies()) {
      this.refused = undefined;
      await this.saveState();
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next read).
    this.lastStatus = undefined;
    this.lastIndexAt = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.updateStatus();
      return;
    }
    await this.discover();
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Whether the login refused by the gateway is the one configured now. */
  refusedApplies() {
    const r = this.refused;
    const config = this.config;
    return Boolean(
      r &&
      r.address === config.address &&
      r.username === (config.login?.username ?? '') &&
      r.tag === tagOf(r.salt, config.login?.password ?? ''),
    );
  }

  // --- Pace ------------------------------------------------------------------

  /** The interval between two reads: longer with many meters (states budget). */
  interval() {
    return Math.max(POLL_INTERVAL, this.meterCount * POLL_PER_METER);
  }

  /** The monotonic time from which the next read may start. */
  dueAt() {
    const mono = this.monotonic();
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.interval();
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      due = Math.max(due, mono + (this.pause.until - now));
    }
    return due;
  }

  /** One timer: the next read when it is due; none while the login is refused. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.refusedApplies()) {
      return;
    }
    const wait = Math.max(0, this.dueAt() - this.monotonic());
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`iskra: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) {
      this.schedule();
    }
  }

  /** One read when it is due; a read running is never doubled. */
  tick({ evenRefused = false } = {}) {
    if (this.busy) {
      return this.busy;
    }
    this.busy = this.read({ evenRefused }).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read({ evenRefused }) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running) {
      return;
    }
    // A refused login is never tried again by itself: only the test button.
    if (!evenRefused && this.refusedApplies()) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt()) {
      return;
    }
    /** Another address or login (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let result;
    try {
      result = await this.readAll(client, gone);
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono, gone);
      return;
    }
    if (gone() || !result) return;
    await this.succeeded(result, mono, gone);
  }

  /**
   * The gateway, its meters, and the values of each supported meter, checked
   * against a second list. Throws a GatewayError for the whole read.
   */
  async readAll(client, gone) {
    const gateway = await client.gateway();
    if (gone()) return undefined;
    const ports = await listOf(client);
    if (gone()) return undefined;
    const meters = ports.filter((p) => p.serial && p.supported).slice(0, MAX_METERS);
    const readings = [];
    const unread = [];
    for (const meter of meters) {
      const reading = { position: meter.position, serial: meter.serial, model: meter.model };
      try {
        reading.measurements = await client.measurements(meter.position);
        if (gone()) return undefined;
        reading.counters = await client.counters(meter.position);
        if (gone()) return undefined;
      } catch (err) {
        if (gone()) return undefined;
        if (!(err instanceof GatewayError) || !METER_ONLY.has(err.code)) {
          throw err;
        }
        // A page of one meter failing never stops the others.
        unread.push({ serial: meter.serial, code: err.code });
        if (!reading.measurements) {
          continue;
        }
        reading.counters = undefined;
      }
      readings.push(reading);
    }
    // The identity of each meter read: the same serial at its position in a
    // second list. Otherwise its values may belong to another meter.
    const again = meters.length > 0 ? await listOf(client) : ports;
    if (gone()) return undefined;
    const swapped = [];
    const checked = readings.filter((r) => {
      const same = again[r.position]?.serial === r.serial;
      if (!same) swapped.push(r.serial);
      return same;
    });
    return {
      gateway,
      ports,
      meters,
      readings: checked,
      unread,
      swapped,
      unsupported: ports.filter((p) => p.serial && !p.supported).map((p) => p.model),
      unreadablePorts: ports.filter((p) => p.unreadable).length,
    };
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      this.savedAttemptAt = now;
      await this.saveState();
    }
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded(result, mono, gone) {
    // An answer: a pause asked before, the retries and a refused login are over.
    this.pause = undefined;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    if (this.refused) {
      this.refused = undefined;
      this.logger.info('iskra: the gateway accepts the login again');
    }
    if (this.gatewaySerial !== undefined && this.gatewaySerial !== result.gateway.serial) {
      this.otherGateway = true;
      this.logger.warn('iskra: another gateway answers at this address');
    }
    this.gatewaySerial = result.gateway.serial;
    this.meterCount = result.meters.length;
    this.current = result.meters.map((m) => m.serial);

    let grew = !this.session.discovered;
    for (const meter of result.meters) {
      const known = this.meters.get(meter.serial);
      if (!known) {
        grew = true;
      }
      // Seen now: moved last, so that the oldest meters leave /data first.
      this.meters.delete(meter.serial);
      this.meters.set(
        meter.serial,
        known ?? {
          serial: meter.serial,
          model: meter.model,
          keys: new Set(),
          importSlot: undefined,
          exportSlot: undefined,
        },
      );
    }
    for (const reading of result.readings) {
      const meter = this.meters.get(reading.serial);
      meter.model = reading.model;
      this.valuesOf(meter, reading);
      const keys = union(
        meter.keys,
        capabilitiesOfDevice(this.createdDevice(meter.serial)),
        capabilitiesOf(reading),
      );
      if (keys.size !== meter.keys.size) {
        grew = true;
      }
      meter.keys = keys;
    }
    while (this.meters.size > MAX_KEPT_METERS) {
      this.meters.delete(this.meters.keys().next().value);
    }
    this.outcome = { at: mono, kind: 'reading', ...result };
    if (grew) {
      this.session.discovered = true;
      await this.discover();
      if (gone()) return;
    }
    await this.publish(result.readings, mono, gone);
    if (gone()) return;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  /**
   * The index and the injection of a reading, from the counter slots of the
   * meter: chosen once (the first active import, the first active export
   * counter) and kept, so that another counter never takes their place.
   */
  valuesOf(meter, reading) {
    reading.imported = undefined;
    reading.exported = undefined;
    reading.slotChanged = false;
    const counters = reading.counters;
    if (!counters) {
      return;
    }
    if (meter.importSlot === undefined) meter.importSlot = slotOf(counters, 'import');
    if (meter.exportSlot === undefined) meter.exportSlot = slotOf(counters, 'export');
    const take = (slot, direction) => {
      if (slot === undefined) return undefined;
      const counter = counters[slot];
      if (!counter || !counter.active || counter.direction !== direction) {
        reading.slotChanged = true;
        return undefined;
      }
      return counter.kwh;
    };
    reading.imported = take(meter.importSlot, 'import');
    reading.exported = take(meter.exportSlot, 'export');
  }

  async failed(err, mono, gone) {
    const code = err?.code ?? 'error';
    const now = this.now();
    // Our own words only (GatewayError codes): never a text of the gateway.
    this.logger.warn(
      `iskra read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at: mono, kind: 'error', err };
    if (code === 'refused') {
      // The principal page refuses the login: final, kept in /data, never
      // tried again by itself (only a new login or the test button).
      if (!this.refusedApplies()) {
        const salt = this.random();
        this.refused = {
          address: this.config.address,
          username: this.config.login?.username ?? '',
          salt,
          tag: tagOf(salt, this.config.login?.password ?? ''),
        };
      }
      this.failures = 0;
      this.nextTryAt = undefined;
      this.lastError = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === 'rate_limited' || code === 'server') {
      const count = (this.pause?.count ?? 0) + 1;
      const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
      const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
      this.pause = {
        until: now + wait,
        count: Math.min(count, 32),
        code,
        status: Number.isInteger(err.status) ? err.status : null,
      };
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    // Retries doubled (never faster than the interval).
    const wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
    this.failures += 1;
    this.lastError = err;
    this.nextTryAt = mono + wait;
    await this.updateStatus();
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    const address = this.config.address;
    if (!this.session?.client) {
      if (this.config.invalidAddress) return [false, T.badAddress];
      if (this.config.invalidLogin) return [false, T.badLogin];
      return [false, T.incomplete];
    }
    const notes = this.heldNotes();
    if (this.refusedApplies()) {
      return [false, T.refused(address, Boolean(this.config.login), notes)];
    }
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      return [false, T.paused(address, this.pause, this.pause.until - now, notes)];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - this.monotonic());
      return [false, T.unreachable(address, this.lastError, wait, notes)];
    }
    if (this.outcome?.kind === 'reading') {
      const o = this.outcome;
      const extra = [];
      if (this.otherGateway) extra.push(T.notes.otherGateway(o.gateway.serial));
      if (o.unsupported.length > 0) extra.push(T.notes.unsupported(o.unsupported));
      if (o.unreadablePorts > 0) extra.push(T.notes.unreadablePorts(o.unreadablePorts));
      if (o.unread.length > 0) extra.push(T.notes.unread(o.unread));
      if (o.swapped.length > 0) extra.push(T.notes.swapped(o.swapped));
      const noIndex = o.readings.filter((r) => r.slotChanged).map((r) => r.serial);
      if (noIndex.length > 0) extra.push(T.notes.slotChanged(noIndex));
      if (o.meters.length === 0) {
        return [true, T.noMeters(o.gateway, extra)];
      }
      const missing = o.meters.filter((m) => !this.createdDevice(m.serial)).map((m) => m.serial);
      if (missing.length > 0) {
        extra.unshift(T.notes.noDevice(missing));
      }
      return [true, T.ok(address, o.gateway, o.meters.length, [...extra, ...notes])];
    }
    return [false, T.waiting(address, notes)];
  }

  /** The indexes held back, for every status (the user must see them while waiting). */
  heldNotes() {
    const notes = [];
    for (const meter of this.meters.values()) {
      const held = this.currentGuard(meter.serial)?.held;
      if (held) notes.push(T.notes.held(meter.serial, held));
    }
    return notes;
  }

  // --- /data -------------------------------------------------------------------------

  /** Keeps the meters, the pause, the refused login, the last read and the guards. */
  async saveState() {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = guard.state();
    }
    // Never overwrite an index state not loaded yet: merged with /data.
    const kept = Object.fromEntries(plainEntries(this.store.load().indexes));
    for (const id of Object.keys(indexes)) delete kept[id];
    const merged = Object.entries({ ...kept, ...indexes }).slice(-MAX_KEPT_INDEXES);
    const meters = {};
    for (const [serial, m] of this.meters) {
      meters[serial] = {
        model: m.model,
        keys: [...m.keys],
        importSlot: m.importSlot ?? null,
        exportSlot: m.exportSlot ?? null,
      };
    }
    const state = {
      meters,
      meterCount: this.meterCount,
      pause: this.pause ?? null,
      refused: this.refused ?? null,
      lastAttemptAt: this.lastAttemptAt ?? null,
      indexes: Object.fromEntries(merged),
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
    } catch (err) {
      this.logger.warn(`Saving the iskra state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Devices -----------------------------------------------------------------------

  /** The created Gladys device of a meter, undefined until the user creates it. */
  createdDevice(serial) {
    const id = ids(this.gladys, serial).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  /** The serial of a meter external id (its form only), or undefined. */
  serialOfExternal(externalId) {
    const probe = ids(this.gladys, 'X').device;
    const prefix = probe.slice(0, -1);
    if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
      return undefined;
    }
    const serial = externalId.slice(prefix.length);
    return SERIAL.test(serial) ? serial : undefined;
  }

  /** The meters offered: those of the last list, or the ones kept before the first read. */
  discoverable() {
    const serials = this.current ?? [...this.meters.keys()];
    return serials.map((s) => this.meters.get(s)).filter(Boolean);
  }

  async discover() {
    if (!this.session?.client) {
      return;
    }
    const devices = [];
    for (const meter of this.discoverable()) {
      const keys = union(meter.keys, capabilitiesOfDevice(this.createdDevice(meter.serial)));
      if (keys.size > 0) {
        devices.push(buildDevice(this.gladys, meter, keys, this.config.address));
      }
    }
    if (devices.length === 0) {
      return;
    }
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the iskra meters failed (${err?.name})`));
  }

  /** The Discover tab asks: the known meters, never a read (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  async onDeviceCreated(device) {
    // Recognized by the form of its external id alone: a new device has no
    // reference of its index yet (nor a state kept for a deleted device).
    const serial = this.serialOfExternal(device?.external_id);
    if (!serial) {
      return;
    }
    const id = ids(this.gladys, serial).feature(FEATURE.CONSUMPTION_INDEX);
    this.guards.delete(id);
    const kept = this.store.load();
    const indexes = Object.fromEntries(plainEntries(kept.indexes));
    delete indexes[id];
    await this.store
      .save({ ...kept, indexes })
      .catch((err) =>
        this.logger.warn(`Clearing the iskra index state failed (${err?.code ?? 'error'})`),
      );
    this.savedKey = undefined;
    this.lastIndexAt = undefined;
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    if (this.serialOfExternal(device?.external_id)) {
      // New features (Update in Discovery): their indexes at the next read.
      this.lastIndexAt = undefined;
      await this.updateStatus();
    }
  }

  // --- Values ------------------------------------------------------------------------

  /** The guard of the index of a created device, from Gladys and /data. */
  guardOf(created, id) {
    if (!this.guards.has(id)) {
      const saved = Object.fromEntries(plainEntries(this.store.load().indexes))[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved, this.now(), {
          maxKw: this.config.maxKw,
          slackKwh: INDEX_SLACK_KWH,
        }),
      );
    }
    return this.guards.get(id);
  }

  /** The guard of a meter with a created device, when there is one. */
  currentGuard(serial) {
    const created = this.createdDevice(serial);
    return created
      ? this.guardOf(created, ids(this.gladys, serial).feature(FEATURE.CONSUMPTION_INDEX))
      : undefined;
  }

  /** The states of a read: the live values every time, the indexes once a minute. */
  async publish(readings, mono, gone) {
    if (this.lastIndexAt !== undefined && mono < this.lastIndexAt) {
      this.lastIndexAt = undefined;
    }
    const indexDue = this.lastIndexAt === undefined || mono - this.lastIndexAt >= INDEX_INTERVAL;
    const states = [];
    let guarded = false;
    for (const reading of readings) {
      const created = this.createdDevice(reading.serial);
      if (!created) {
        continue;
      }
      const external = ids(this.gladys, reading.serial);
      const own = liveStates(external, reading.measurements);
      if (indexDue && reading.counters) {
        const id = external.feature(FEATURE.CONSUMPTION_INDEX);
        const guard = this.guardOf(created, id);
        const raw = reading.imported;
        const total = finite(raw) ? round(raw, 3) : undefined;
        const plausible = total !== undefined && guard.accept(total, this.now());
        if (total !== undefined && !plausible && guard.held) {
          this.logger.warn(
            `iskra consumption index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
          );
        }
        guarded = true;
        // While a value is held, the last accepted one is sent again (no delta for the core).
        const index = plausible ? total : guard.held ? guard.last?.value : undefined;
        own.push(...indexStates(external, index, reading.exported));
      }
      // Only the features the created device has (they are fixed at its creation).
      const features = created.features
        ? new Set(created.features.map((f) => f.external_id))
        : null;
      states.push(
        ...(features ? own.filter((s) => features.has(s.device_feature_external_id)) : own),
      );
    }
    if (indexDue) {
      this.lastIndexAt = mono;
    }
    if (guarded) {
      // The guards are in /data BEFORE Gladys gets the values: a crash in
      // between never sends an index /data does not know.
      await this.saveState();
      if (gone()) return;
    }
    if (states.length === 0) {
      return;
    }
    await this.gladys
      .publishChangedStates(states, { heartbeat: STATE_HEARTBEAT })
      .catch((err) => this.logger.warn(`Publishing the iskra values failed (${err?.name})`));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * The "Accept the held index" button: takes each value held, as shown now
   * (plus what the meter may draw until the next read, src/guard.js), never
   * anything else. Published at the next read (never a read sooner).
   */
  async acceptHeldIndex() {
    const accepted = [];
    for (const meter of this.meters.values()) {
      const one = this.currentGuard(meter.serial)?.acceptHeld();
      if (one) {
        accepted.push({ serial: meter.serial, ...one });
        this.logger.info(
          `iskra consumption index ${one.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
        );
      }
    }
    if (accepted.length === 0) {
      return T.accept.nothing;
    }
    this.lastIndexAt = undefined;
    return T.accept.done(accepted);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it (even with a login refused before: only a
   * success lifts the refusal); otherwise it tells the last one.
   */
  async testConnection() {
    if (!this.session?.client) {
      return this.currentStatus()[1];
    }
    if (this.pause && this.now() < this.pause.until) {
      return this.currentStatus()[1];
    }
    if (this.busy || this.dueAt() > this.monotonic()) {
      return this.describeOutcome();
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    const since = this.monotonic();
    try {
      return await Promise.race([
        this.tick({ evenRefused: true }).then(() => this.describeOutcome(since)),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running) this.schedule();
    }
  }

  /**
   * The last read in words, and the time to the next one. `since`: when this
   * click started a read; a read from then on is told as "read now".
   */
  describeOutcome(since) {
    const mono = this.monotonic();
    const refused = this.refusedApplies();
    const next = refused ? undefined : Math.max(0, this.dueAt() - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return refused ? this.currentStatus()[1] : T.test.notYet(next, this.interval());
    }
    const ago =
      since !== undefined && outcome.at >= since ? undefined : Math.max(0, mono - outcome.at);
    if (outcome.kind === 'reading') {
      const meters = outcome.readings.map((r) => ({
        serial: r.serial,
        model: r.model,
        power: r.measurements.power,
        index: r.imported,
      }));
      return T.test.reading(outcome.gateway, meters, outcome.meters.length, ago, next);
    }
    return T.test.failed(this.config.address, outcome.err, ago, next);
  }
}
