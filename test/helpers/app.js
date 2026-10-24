// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted gateway and a virtual clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IskraApp } from '../../src/app.js';
import { buildDevice, capabilitiesOf } from '../../src/devices.js';
import { GatewayClient } from '../../src/iskra/client.js';
import { parseCounters, parseMeasurements } from '../../src/iskra/model.js';
import { createMemoryStore } from '../../src/store.js';
import {
  ADDRESS,
  NOW,
  SERIAL_A,
  counter,
  devices,
  gateway,
  json,
  measurement,
} from '../fixtures/iskra.js';
import { createFetch, timeoutError } from './fakeNet.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'iskra';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const F = (key, serial = SERIAL_A) => `ext:${SELECTOR}:meter:${serial}:${key}`;
export const CONFIG = { address: ADDRESS };

/** The device of a meter as the user created it, the index Gladys holds when given. */
export function created({ serial = SERIAL_A, model = 'IE38MD', index } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const counters = parseCounters(counter());
  const reading = {
    measurements: parseMeasurements(measurement()),
    imported: counters[0].kwh,
    exported: counters[1].kwh,
  };
  const device = buildDevice(gladys, { serial, model }, capabilitiesOf(reading), ADDRESS);
  if (index) {
    const feature = device.features.find((f) => f.external_id === F('consumption_index', serial));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

/** The answers of a default gateway, by path. */
export const defaults = {
  '/api': () => gateway(),
  '/api/devices': () => devices(),
  '/api/measurement/0': () => measurement(),
  '/api/counter/0': () => counter(),
};

/**
 * The gateway: `world(path, t, init)` -> an answer object | 'timeout' |
 * a Response | undefined (404).
 */
export function createGateway(world = (path) => defaults[path]?.()) {
  const gw = { world, clock: { now: NOW } };
  gw.net = createFetch(async ({ path, init }) => {
    // An answer may be a promise: a slow page, released by the test.
    const answer = await gw.world(path, gw.clock.now, init);
    if (answer === 'timeout') throw timeoutError();
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response('not found', { status: 404 });
    return json(answer);
  });
  return gw;
}

export async function setup({
  devices: known = [],
  store,
  now = NOW,
  gw = createGateway(),
  config = CONFIG,
  random,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  gw.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? createMemoryStore();
  const app = new IskraApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    // The wall clock may be set apart from the monotonic one (`wall.offset`).
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now,
    timers,
    store: kept,
    clientFactory: (options) => new GatewayClient({ ...options, fetchImpl: gw.net.fetch }),
    ...(random ? { random } : {}),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  return { app, gladys, clock, store: kept, gw, start, wait, advance, lines };
}
