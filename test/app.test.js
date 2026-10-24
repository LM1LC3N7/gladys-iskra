// -----------------------------------------------------------------------------
// The app end to end against the SDK's fake Gladys, a scripted gateway and a
// virtual clock: discovery, states, the guarded index of each meter, the
// pace, late answers, identity, the refused login, pauses, buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagOf } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import {
  ADDRESS,
  NOW,
  SERIAL_A,
  SERIAL_B,
  counter,
  devices,
  gateway,
  measurement,
} from './fixtures/iskra.js';
import {
  CONFIG,
  F,
  MINUTE,
  SECOND,
  created,
  createGateway,
  defaults,
  setup,
} from './helpers/app.js';

const statesOf = (gladys, key, serial) =>
  gladys.fake.states
    .filter((s) => s.device_feature_external_id === F(key, serial))
    .map((s) => s.state);
const status = (s) => s.gladys.fake.connectionStatus;
const pathsOf = (gw) => gw.net.calls.map((c) => c.path);

/** A gateway whose answers come from `defaults`, overridden by `answers`. */
const gatewayWith = (answers) =>
  createGateway((path, t, init) => {
    const own = answers[path] ?? defaults[path];
    return own?.(t, init);
  });

test('without a device: each meter is offered in Discovery, the status says so', async () => {
  const s = await setup();
  await s.start();
  assert.deepEqual(pathsOf(s.gw), [
    '/api',
    '/api/devices',
    '/api/measurement/0',
    '/api/counter/0',
    '/api/devices',
  ]);
  const [device] = s.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, `ext:iskra:meter:${SERIAL_A}`);
  assert.equal(device.name, `Iskra IE38MD ${SERIAL_A}`);
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys, [
    'power',
    'consumption_index',
    'injection_index',
    'voltage_l1',
    'voltage_l2',
    'voltage_l3',
    'current_l1',
    'current_l2',
    'current_l3',
    'power_l1',
    'power_l2',
    'power_l3',
    'power_factor',
    'frequency',
    'temperature',
  ]);
  const injection = device.features.find((f) => f.external_id === F('injection_index'));
  assert.equal(injection.category, 'unknown', 'the injection is never an energy index');
  assert.equal(status(s).connected, true);
  assert.match(status(s).message.en, /SG 12345678.*1 meter\(s\) read.*Create the device/);
  assert.equal(s.gladys.fake.states.length, 0);
});

test('a created device: live values every 30 s, the indexes once a minute', async () => {
  let wh = 9_000_000;
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: wh }) });
  const s = await setup({ devices: [created()], gw });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500]);
  assert.deepEqual(statesOf(s.gladys, 'voltage_l1'), [230.1]);
  assert.deepEqual(statesOf(s.gladys, 'current_l2'), [2.17]);
  assert.deepEqual(statesOf(s.gladys, 'frequency'), [50.01]);
  assert.deepEqual(statesOf(s.gladys, 'temperature'), [31.5]);
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000]);
  assert.deepEqual(statesOf(s.gladys, 'injection_index'), [1500]);
  wh = 9_000_500;
  await s.wait(30 * SECOND);
  assert.equal(s.gw.net.calls.length, 10, 'one read every 30 s');
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000], 'not before a minute');
  await s.wait(30 * SECOND);
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000, 9000.5]);
  assert.match(status(s).message.en, /Connected/);
  assert.doesNotMatch(status(s).message.en, /Create the device/);
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('the index: never 0, a jump held until the user accepts it', async () => {
  let wh = 9_000_000;
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: wh }) });
  const s = await setup({
    devices: [created({ index: { value: 9000, at: NOW - MINUTE } })],
    gw,
  });
  await s.start();
  wh = 0;
  await s.wait(MINUTE);
  wh = 19_000_000;
  await s.wait(MINUTE);
  await s.wait(MINUTE);
  const published = statesOf(s.gladys, 'consumption_index');
  assert.ok(!published.includes(0));
  assert.ok(!published.includes(19_000));
  assert.match(status(s).message.en, new RegExp(`meter ${SERIAL_A} jumped from 9000 to 19000 kWh`));
  assert.equal(s.store.data.indexes[F('consumption_index')].held.to, 19_000);
  const first = await s.app.acceptHeldIndex();
  assert.match(
    first.en,
    /A second click accepts these values, plus what each meter may measure between the two clicks \(at most 8\.833 kWh\): meter 41000001: from 9000 to 19000 kWh \(10000 kWh/,
  );
  await s.wait(MINUTE);
  assert.ok(!statesOf(s.gladys, 'consumption_index').includes(19_000), 'one click takes nothing');
  const ack = await s.app.acceptHeldIndex();
  assert.match(ack.en, /Accepted: meter 41000001, index 19000 kWh/);
  await s.wait(MINUTE);
  assert.equal(statesOf(s.gladys, 'consumption_index').at(-1), 19_000);
  assert.doesNotMatch(status(s).message.en, /jumped/);
  assert.equal(
    (await s.app.acceptHeldIndex()).en,
    'No consumption index is held back: nothing to accept.',
  );
});

test('the margin of the guard comes from the configuration', async () => {
  let wh = 9_000_000;
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: wh }) });
  const device = created({ index: { value: 9000, at: NOW - MINUTE } });
  // 50 kWh in 2 minutes is 1.5 MW: within 2000 kW (66.7 kWh), far over 100 kW.
  const s = await setup({ devices: [device], gw, config: { ...CONFIG, max_power_kw: 2000 } });
  await s.start();
  wh = 9_050_000;
  await s.wait(MINUTE);
  await s.wait(MINUTE);
  assert.equal(statesOf(s.gladys, 'consumption_index').at(-1), 9050);
  const low = await setup({ devices: [device], gw });
  wh = 9_000_000;
  await low.start();
  wh = 9_050_000;
  await low.wait(MINUTE);
  await low.wait(MINUTE);
  assert.ok(!statesOf(low.gladys, 'consumption_index').includes(9050), 'held at 100 kW');
});

test('a held index survives a restart; saving the configuration accepts nothing', async () => {
  const store = createMemoryStore();
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: 500_000 }) });
  const device = created({ index: { value: 9000, at: NOW - MINUTE } });
  let s = await setup({ devices: [device], gw, store });
  await s.start();
  await s.app.start(CONFIG);
  await s.wait(MINUTE);
  assert.ok(!statesOf(s.gladys, 'consumption_index').includes(500));
  await s.app.stop();
  s = await setup({ devices: [device], gw, store, now: s.clock.now + MINUTE });
  await s.start();
  assert.match(status(s).message.en, /dropped from 9000 to 500 kWh/);
  assert.ok(!statesOf(s.gladys, 'consumption_index').includes(500));
});

test('the pace: never two reads less than 30 s apart, whatever asks', async () => {
  const store = createMemoryStore();
  const gw = createGateway();
  const s = await setup({ gw, store });
  await s.start();
  const one = gw.net.calls.length;
  await s.app.start(CONFIG);
  await s.app.scan();
  await s.app.start(await s.gladys.getConfig());
  await s.app.onDeviceCreated(created());
  const test1 = await s.app.testConnection();
  assert.match(test1.en, /Last read .* ago.*Next read in 30 s/);
  await s.wait(29 * SECOND);
  assert.equal(gw.net.calls.length, one, 'a reconnection, a save, a scan, the test: no read');
  await s.wait(SECOND);
  assert.equal(gw.net.calls.length, 2 * one);
  // A restart of the container 2 s after a read: the time is in /data.
  await s.app.stop();
  const again = await setup({ gw, store, now: s.clock.now + 2 * SECOND });
  await again.start();
  assert.equal(gw.net.calls.length, 2 * one);
  assert.ok(store.data.lastAttemptAt <= s.clock.now);
});

test('many meters: the interval grows, the states stay within the budget', async () => {
  const meters = Array.from({ length: 10 }, (_, i) => ({ model: 'MC784', serial: `5000${i}` }));
  const gw = createGateway((path) => {
    if (path === '/api') return gateway();
    if (path === '/api/devices') return devices(meters);
    if (path.startsWith('/api/measurement/')) return measurement();
    if (path.startsWith('/api/counter/')) return counter();
    return undefined;
  });
  const s = await setup({ gw, devices: meters.map((m) => created(m)) });
  await s.start();
  const one = gw.net.calls.length;
  assert.equal(one, 3 + 2 * 10);
  await s.wait(79 * SECOND);
  assert.equal(gw.net.calls.length, one, '10 meters: one read every 80 s');
  await s.wait(SECOND);
  assert.equal(gw.net.calls.length, 2 * one);
  const perMinute = s.gladys.fake.states.length / 2; // two reads, the first one counting double
  assert.ok(perMinute < 300, `${perMinute} states a minute`);
});

test('every connection publishes the status and the Discovery list again', async () => {
  const s = await setup();
  await s.start();
  const statuses = s.gladys.fake.connectionStatuses.length;
  const discoveries = s.gladys.fake.bodies('POST', '/discovered_device').length;
  // What index.js does on every `connected`.
  await s.app.start(await s.gladys.getConfig());
  await s.app.idle();
  assert.equal(s.gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(s.gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('a late answer of an old address publishes nothing and sets no status', async () => {
  const gw = createGateway();
  const s = await setup({ gw, devices: [created()] });
  gw.net.hold = true;
  await s.app.start(CONFIG);
  // Not awaited: the timer runs the read, which waits for the held answer.
  const running = s.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gw.net.calls.length, 1);
  await s.app.start({ address: '192.168.1.81' });
  const statuses = s.gladys.fake.connectionStatuses.length;
  gw.net.hold = false;
  gw.net.release();
  await running;
  await s.app.idle();
  assert.deepEqual(statesOf(s.gladys, 'power'), []);
  assert.equal(s.gladys.fake.connectionStatuses.length, statuses);
});

test('a login changed in the middle of a read: the old read publishes nothing', async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const gw = gatewayWith({ '/api/measurement/0': () => slow.then(() => measurement()) });
  const s = await setup({ gw, devices: [created()] });
  await s.app.start(CONFIG);
  const running = s.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pathsOf(gw), ['/api', '/api/devices', '/api/measurement/0']);
  await s.app.start({ ...CONFIG, username: 'admin', password: 'other' });
  const statuses = s.gladys.fake.connectionStatuses.length;
  release();
  await running;
  await s.app.idle();
  assert.deepEqual(statesOf(s.gladys, 'power'), []);
  assert.equal(s.gladys.fake.connectionStatuses.length, statuses);
  assert.equal(gw.net.calls.length, 3, 'the old read stops, the new one waits for its turn');
});

test('identity: a meter swapped during the read gets nothing; values go by serial', async () => {
  let second = false;
  let lists = 0;
  const gw = createGateway((path) => {
    if (path === '/api/devices') {
      lists += 1;
      // The port of meter A holds meter B in the second list of the read.
      const swapped = second && lists % 2 === 0;
      return devices([{ model: 'IE38MD', serial: swapped ? SERIAL_B : SERIAL_A }]);
    }
    return defaults[path]?.();
  });
  const s = await setup({ gw, devices: [created(), created({ serial: SERIAL_B })] });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500]);
  second = true;
  await s.wait(30 * SECOND);
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500], 'nothing published this time');
  assert.deepEqual(statesOf(s.gladys, 'power', SERIAL_B), [], 'never to the other meter');
  assert.match(status(s).message.en, /list of meters changed during the read/);
});

test('another meter on the port: its own device, the old one untouched', async () => {
  let serial = SERIAL_A;
  const gw = createGateway((path) =>
    path === '/api/devices' ? devices([{ model: 'IE38MD', serial }]) : defaults[path]?.(),
  );
  const s = await setup({ gw, devices: [created(), created({ serial: SERIAL_B })] });
  await s.start();
  serial = SERIAL_B;
  await s.wait(30 * SECOND);
  assert.deepEqual(statesOf(s.gladys, 'power', SERIAL_A), [1500]);
  assert.deepEqual(statesOf(s.gladys, 'power', SERIAL_B), [1500]);
  const discovered = s.gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(discovered, [`ext:iskra:meter:${SERIAL_B}`]);
});

test('the login: a cookie to the gateway only, never in the logs nor in /data', async () => {
  const gw = createGateway();
  const store = createMemoryStore();
  const s = await setup({
    gw,
    store,
    config: { ...CONFIG, username: 'admin', password: 's3cret-pass' },
  });
  await s.start();
  const expected = `Authorization=Basic ${Buffer.from('admin:s3cret-pass').toString('base64')}`;
  for (const call of gw.net.calls) {
    assert.equal(call.host, ADDRESS);
    assert.equal(call.init.headers.Cookie, expected);
    assert.equal(call.init.redirect, 'manual');
  }
  const everything = JSON.stringify([s.lines, store.data, s.gladys.fake.connectionStatuses]);
  assert.ok(!everything.includes('s3cret'));
  assert.ok(!everything.includes(Buffer.from('admin:s3cret-pass').toString('base64')));
});

test('a refused login stops the reads, kept across restarts, lifted by a new login', async () => {
  let accepted = 'right';
  const gw = createGateway((path, t, init) => {
    const cookie = init.headers.Cookie ?? '';
    const ok =
      cookie === `Authorization=Basic ${Buffer.from(`admin:${accepted}`).toString('base64')}`;
    if (path === '/api' && !ok) return new Response('no', { status: 403 });
    return defaults[path]?.();
  });
  const store = createMemoryStore();
  const wrong = { ...CONFIG, username: 'admin', password: 'wrong' };
  const s = await setup({ gw, store, config: wrong });
  await s.start();
  assert.equal(gw.net.calls.length, 1);
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /refuses this login: reads stopped/);
  assert.ok(!JSON.stringify(store.data).includes('wrong'));
  assert.ok(Number.isInteger(store.data.refused.tag) && store.data.refused.tag < 256);
  await s.wait(2 * 3_600_000);
  assert.equal(gw.net.calls.length, 1, 'never tried again by itself');
  // A save with the same login: still stopped.
  await s.app.start(wrong);
  await s.wait(MINUTE);
  assert.equal(gw.net.calls.length, 1);
  // A restart: still stopped.
  await s.app.stop();
  const again = await setup({ gw, store, config: wrong, now: s.clock.now });
  await again.start();
  assert.equal(gw.net.calls.length, 1);
  assert.match(status(again).message.en, /refuses this login/);
  // A new password: tried at once (the pace allows it), and read.
  await again.app.start({ ...wrong, password: 'right' });
  await again.wait(0);
  assert.equal(status(again).connected, true);
  assert.equal(again.store.data.refused, null);
});

test('the test button tries a refused login once more; only a success lifts it', async () => {
  let accept = false;
  const gw = createGateway((path) =>
    path === '/api' && !accept ? new Response('no', { status: 401 }) : defaults[path]?.(),
  );
  const config = { ...CONFIG, username: 'admin', password: 'pw' };
  const s = await setup({ gw, config });
  await s.start();
  assert.match(status(s).message.en, /refuses this login/);
  await s.wait(30 * SECOND);
  let answer = await s.app.testConnection();
  assert.match(answer.en, /login refused/);
  assert.equal(gw.net.calls.length, 2);
  assert.match(status(s).message.en, /refuses this login/);
  // Not due yet: the click tells the last read, no request.
  answer = await s.app.testConnection();
  assert.match(answer.en, /Last read .* ago.*login refused/);
  assert.equal(gw.net.calls.length, 2);
  accept = true;
  await s.wait(30 * SECOND);
  assert.equal(gw.net.calls.length, 2, 'still stopped');
  answer = await s.app.testConnection();
  assert.match(answer.en, /Read now: gateway SG 12345678/);
  assert.equal(status(s).connected, true);
  await s.wait(30 * SECOND);
  assert.ok(gw.net.calls.length > 7, 'the reads go on');
});

test('a page of one meter refused or failing: the others are read, nothing final', async () => {
  const meters = [
    { model: 'IE38MD', serial: SERIAL_A },
    { model: 'MC750', serial: SERIAL_B },
  ];
  const gw = createGateway((path) => {
    if (path === '/api/devices') return devices(meters);
    if (path === '/api/measurement/1') return new Response('no', { status: 403 });
    if (path === '/api/counter/1') return counter();
    return defaults[path]?.();
  });
  const s = await setup({
    gw,
    devices: [created(), created({ serial: SERIAL_B, model: 'MC750' })],
  });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500]);
  assert.deepEqual(statesOf(s.gladys, 'power', SERIAL_B), []);
  assert.equal(status(s).connected, true);
  assert.match(
    status(s).message.en,
    new RegExp(`Not read this time: ${SERIAL_B} \\(login refused\\)`),
  );
  await s.wait(30 * SECOND);
  assert.ok(gw.net.calls.length >= 12, 'the reads go on');
});

test('the counters failing: the live values go on, the index waits', async () => {
  const gw = gatewayWith({ '/api/counter/0': () => new Response('x', { status: 500 }) });
  const s = await setup({ gw, devices: [created()] });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500]);
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), []);
  assert.equal(status(s).connected, true);
});

test('429 or 5xx on the gateway: a pause kept in /data, never faster', async () => {
  let busy = true;
  const gw = createGateway((path) =>
    busy && path === '/api'
      ? new Response('x', { status: 429, headers: { 'retry-after': '600' } })
      : defaults[path]?.(),
  );
  const store = createMemoryStore();
  const s = await setup({ gw, store });
  await s.start();
  assert.match(status(s).message.en, /asks to wait.*10 min/);
  assert.equal(store.data.pause.code, 'rate_limited');
  busy = false;
  await s.wait(9 * MINUTE);
  assert.equal(gw.net.calls.length, 1);
  await s.app.stop();
  const again = await setup({ gw, store, now: s.clock.now });
  await again.start();
  assert.equal(gw.net.calls.length, 1, 'the pause survives a restart');
  await again.wait(MINUTE);
  assert.ok(gw.net.calls.length > 1);
  assert.equal(status(again).connected, true);
});

test('an unreachable gateway: retries doubled, the status says so', async () => {
  const gw = createGateway(() => 'timeout');
  const s = await setup({ gw });
  await s.start();
  assert.match(status(s).message.en, /could not be read \(no answer\): new try in 30 s/);
  await s.wait(30 * SECOND);
  assert.match(status(s).message.en, /new try in 1 min/);
  assert.equal(gw.net.calls.length, 2);
});

test('not a gateway: an answer of the wrong shape is refused', async () => {
  const gw = createGateway((path) => (path === '/api' ? { hello: 'world' } : undefined));
  const s = await setup({ gw });
  await s.start();
  assert.match(status(s).message.en, /not an answer of an Iskra Smart Gateway/);
});

test('unsupported models and empty ports are not read; the status names the models', async () => {
  const gw = createGateway((path) =>
    path === '/api/devices' ? devices([{ model: 'XYZ1', serial: SERIAL_B }]) : defaults[path]?.(),
  );
  const s = await setup({ gw });
  await s.start();
  assert.deepEqual(pathsOf(gw), ['/api', '/api/devices']);
  assert.match(status(s).message.en, /lists no supported meter.*XYZ1/);
});

test('the counter of the index is chosen once: another one never takes its place', async () => {
  let swapped = false;
  const gw = gatewayWith({
    '/api/counter/0': () =>
      swapped
        ? {
            counters: {
              non_resettable: [
                { value: 1_500_000, unit: 'Wh', direction: 'export' },
                { value: 9_000_000, unit: 'Wh', direction: 'import' },
              ],
            },
          }
        : counter(),
  });
  const s = await setup({ gw, devices: [created()] });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000]);
  swapped = true;
  await s.wait(MINUTE);
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000]);
  assert.match(status(s).message.en, /register used for the consumption index of 41000001 changed/);
});

test('a device created: its index state is cleared, by the form of its id alone', async () => {
  const store = createMemoryStore({
    indexes: {
      [F('consumption_index', '99999999')]: { last: { value: 5, at: NOW }, held: null },
      [F('consumption_index')]: { last: { value: 7, at: NOW }, held: null },
    },
  });
  const s = await setup({ store });
  await s.start();
  await s.app.onDeviceCreated({ external_id: 'ext:iskra:meter:99999999' });
  assert.equal(store.data.indexes[F('consumption_index', '99999999')], undefined);
  assert.ok(store.data.indexes[F('consumption_index')], 'the other meter keeps its state');
  await s.app.onDeviceCreated({ external_id: 'ext:other:thing' });
});

test('a restart offers the meters seen before the first read', async () => {
  const store = createMemoryStore();
  const s = await setup({ store });
  await s.start();
  await s.app.stop();
  const gw = createGateway(() => 'timeout');
  const again = await setup({ store, gw, now: s.clock.now + MINUTE });
  await again.start();
  const [device] = again.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, `ext:iskra:meter:${SERIAL_A}`);
  assert.equal(device.features.length, 15);
});

test('the configuration: incomplete, bad address, half a login', async () => {
  let s = await setup({ config: {} });
  await s.start();
  assert.match(status(s).message.en, /Enter the address/);
  s = await setup({ config: { address: 'http://user:pw@1.2.3.4' } });
  await s.start();
  assert.match(status(s).message.en, /not valid/);
  s = await setup({ config: { ...CONFIG, username: 'admin' } });
  await s.start();
  assert.match(status(s).message.en, /login is incomplete/);
  assert.equal(s.gw.net.calls.length, 0);
  assert.match((await s.app.testConnection()).en, /login is incomplete/);
});

// --- Review r1 ---------------------------------------------------------------------

const twoMeters = [
  { model: 'IE38MD', serial: SERIAL_A },
  { model: 'IE38MD', serial: SERIAL_B },
];

/** A gateway with two meters, their import registers in Wh from `wh`. */
function twoMeterGateway(wh) {
  return createGateway((path) => {
    if (path === '/api') return gateway();
    if (path === '/api/devices') return devices(twoMeters);
    if (path.startsWith('/api/measurement/')) return measurement();
    if (path === '/api/counter/0') return counter({ importWh: wh.a });
    if (path === '/api/counter/1') return counter({ importWh: wh.b });
    return undefined;
  });
}

test('r1-1: accept in two clicks, bounded per meter to what the first click listed', async () => {
  const wh = { a: 9_000_000, b: 5_000_000 };
  const gw = twoMeterGateway(wh);
  const s = await setup({
    gw,
    devices: [
      created({ index: { value: 9000, at: NOW - MINUTE } }),
      created({ serial: SERIAL_B, index: { value: 5000, at: NOW - MINUTE } }),
    ],
  });
  await s.start();
  wh.a = 19_000_000;
  await s.wait(MINUTE);
  const first = await s.app.acceptHeldIndex();
  assert.match(first.en, /meter 41000001: from 9000 to 19000 kWh/);
  assert.doesNotMatch(first.en, /41000002/);
  // After the first click: B jumps, A's held value grows far beyond the margin.
  wh.b = 905_000_000;
  wh.a = 90_000_000;
  await s.wait(MINUTE);
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Not accepted, the value changed since the first click: meter 41000001/);
  assert.doesNotMatch(second.en, /Accepted:/);
  await s.wait(MINUTE);
  assert.ok(!statesOf(s.gladys, 'consumption_index').includes(90_000));
  assert.ok(!statesOf(s.gladys, 'consumption_index', SERIAL_B).includes(905_000));
});

test('r1-1: the second click takes A as listed, never B held after the first click', async () => {
  const wh = { a: 9_000_000, b: 5_000_000 };
  const gw = twoMeterGateway(wh);
  const s = await setup({
    gw,
    devices: [
      created({ index: { value: 9000, at: NOW - MINUTE } }),
      created({ serial: SERIAL_B, index: { value: 5000, at: NOW - MINUTE } }),
    ],
  });
  await s.start();
  wh.a = 19_000_000;
  await s.wait(MINUTE);
  await s.app.acceptHeldIndex();
  wh.b = 905_000_000;
  await s.wait(MINUTE);
  const second = await s.app.acceptHeldIndex();
  assert.match(second.en, /Accepted: meter 41000001, index 19000 kWh/);
  assert.match(second.en, /Other indexes are still held/);
  await s.wait(MINUTE);
  assert.equal(statesOf(s.gladys, 'consumption_index').at(-1), 19_000);
  assert.ok(!statesOf(s.gladys, 'consumption_index', SERIAL_B).includes(905_000));
  assert.match(status(s).message.en, /meter 41000002 jumped from 5000 to 905000 kWh/);
});

test('r1-1: a second click after 5 minutes, or too soon, only lists again', async () => {
  let wh = 9_000_000;
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: wh }) });
  const s = await setup({ gw, devices: [created({ index: { value: 9000, at: NOW - MINUTE } })] });
  await s.start();
  wh = 19_000_000;
  await s.wait(MINUTE);
  await s.app.acceptHeldIndex();
  await s.wait(5 * MINUTE + SECOND);
  const late = await s.app.acceptHeldIndex();
  assert.match(late.en, /A second click accepts/);
  const soon = await s.app.acceptHeldIndex();
  assert.match(soon.en, /A second click accepts/, 'a double click is not a confirmation');
  await s.wait(MINUTE);
  assert.ok(!statesOf(s.gladys, 'consumption_index').includes(19_000));
});

test('r1-2: a meter page timing out only leaves that meter unread', async () => {
  const gw = createGateway((path) => {
    if (path === '/api') return gateway();
    if (path === '/api/devices') return devices(twoMeters);
    if (path === '/api/measurement/1') return 'timeout';
    if (path.startsWith('/api/measurement/')) return measurement();
    if (path.startsWith('/api/counter/')) return counter();
    return undefined;
  });
  const s = await setup({ gw, devices: [created(), created({ serial: SERIAL_B })] });
  await s.start();
  assert.deepEqual(statesOf(s.gladys, 'power'), [1500]);
  assert.equal(status(s).connected, true);
  assert.match(status(s).message.en, /1 of 2 meter\(s\) read/);
  assert.match(status(s).message.en, /Not read this time: 41000002 \(no answer\)/);
  assert.ok(!pathsOf(gw).includes('/api/counter/1'), 'its counter page is skipped');
});

test('r1-2: a round never takes longer than its budget', async () => {
  const meters = Array.from({ length: 6 }, (_, i) => ({ model: 'IE38', serial: `6000${i}` }));
  const gw = createGateway((path) => {
    if (path === '/api') return gateway();
    if (path === '/api/devices') return devices(meters);
    if (path.startsWith('/api/measurement/')) {
      gw.clock.now += 25 * SECOND; // a slow page
      return measurement();
    }
    if (path.startsWith('/api/counter/')) return counter();
    return undefined;
  });
  const s = await setup({ gw });
  await s.start();
  const measured = pathsOf(gw).filter((p) => p.startsWith('/api/measurement/'));
  assert.equal(measured.length, 3, '75 s spent: the 3 others wait');
  assert.match(status(s).message.en, /60003 \(the round took too long/);
});

test('r1-3: a serial on two ports: not read, not offered, the status says so', async () => {
  const gw = createGateway((path) =>
    path === '/api/devices'
      ? devices([
          { model: 'IE38MD', serial: SERIAL_A },
          { model: 'IE38MD', serial: SERIAL_A },
        ])
      : defaults[path]?.(),
  );
  const s = await setup({ gw, devices: [created()] });
  await s.start();
  assert.ok(!pathsOf(gw).some((p) => p.startsWith('/api/measurement/')));
  assert.deepEqual(statesOf(s.gladys, 'power'), []);
  assert.match(status(s).message.en, /same serial number is given on ports 1, 2/);
  assert.deepEqual(s.gladys.fake.discoveredDevices, []);
});

test('r1-4: another register at the place of the index (by its name): nothing read', async () => {
  let reordered = false;
  const gw = gatewayWith({
    '/api/counter/0': () =>
      reordered
        ? {
            counters: {
              non_resettable: [
                { name: 'Import T1', value: 9_000_200, unit: 'Wh', direction: 'import' },
                { name: 'Counter 1', value: 9_000_000, unit: 'Wh', direction: 'import' },
              ],
            },
          }
        : counter(),
  });
  const store = createMemoryStore();
  const s = await setup({ gw, store, devices: [created()] });
  await s.start();
  assert.equal(store.data.meters[SERIAL_A].importName, 'Counter 1');
  reordered = true;
  await s.wait(MINUTE);
  assert.deepEqual(statesOf(s.gladys, 'consumption_index'), [9000]);
  assert.match(status(s).message.en, /register used for the consumption index of 41000001 changed/);
});

test('r1-5: a device created again chooses its registers again', async () => {
  let changed = false;
  const gw = gatewayWith({
    '/api/counter/0': () =>
      changed
        ? {
            counters: {
              non_resettable: [
                { name: 'Counter 1', value: 120_000, unit: 'varh', direction: 'import' },
                { name: 'Counter 2', value: 9_100_000, unit: 'Wh', direction: 'import' },
              ],
            },
          }
        : counter(),
  });
  const store = createMemoryStore();
  const s = await setup({ gw, store, devices: [created()] });
  await s.start();
  changed = true;
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /register used for the consumption index/);
  // The user deletes and creates the device again.
  await s.app.onDeviceCreated(created());
  assert.equal(store.data.meters[SERIAL_A].importSlot, null);
  await s.wait(MINUTE);
  assert.equal(statesOf(s.gladys, 'consumption_index').at(-1), 9100);
  assert.equal(store.data.meters[SERIAL_A].importSlot, 1);
  assert.doesNotMatch(status(s).message.en, /register used for/);
});

test('r1-6: a meter with resettable registers only has no index, the status says so', async () => {
  const gw = createGateway((path) => {
    if (path === '/api/devices') return devices([{ model: 'MC750', serial: SERIAL_A }]);
    if (path === '/api/counter/0') {
      return { counters: { resettable: [{ value: 5, unit: 'Wh', direction: 'import' }] } };
    }
    return defaults[path]?.();
  });
  const s = await setup({ gw });
  await s.start();
  const [device] = s.gladys.fake.discoveredDevices;
  assert.ok(!device.features.some((f) => f.external_id === F('consumption_index')));
  assert.match(status(s).message.en, /41000001: no non-resettable register.*no consumption index/);
});

test('r1-7: values unchanged for 15 minutes are no longer sent, even after a restart', async () => {
  const store = createMemoryStore();
  const s = await setup({ store, devices: [created()] });
  const calls = [];
  const spy = (gladys) => {
    const real = gladys.publishChangedStates.bind(gladys);
    gladys.publishChangedStates = (states, options) => {
      calls.push(states.map((x) => x.device_feature_external_id));
      return real(states, options);
    };
  };
  spy(s.gladys);
  await s.start();
  await s.wait(14 * MINUTE);
  assert.ok(calls.at(-1).includes(F('power')));
  await s.wait(MINUTE + 30 * SECOND);
  assert.ok(!calls.at(-1).includes(F('power')), 'frozen: no live value');
  assert.match(status(s).message.en, /values of meter\(s\) 41000001 have not changed for 15 min/);
  // A restart: the same fingerprint keeps its age.
  await s.app.stop();
  const again = await setup({ store, devices: [created()], now: s.clock.now });
  calls.length = 0;
  spy(again.gladys);
  await again.start();
  await again.wait(30 * SECOND);
  assert.ok(again.gw.net.calls.length > 0);
  assert.ok(calls.every((list) => !list.includes(F('power'))));
  assert.match(status(again).message.en, /have not changed/);
});

test('r1-7: values that move are always sent', async () => {
  let w = 1500;
  const gw = gatewayWith({ '/api/measurement/0': () => measurement({ w: (w += 3) }) });
  const s = await setup({ gw, devices: [created()] });
  await s.start();
  await s.wait(20 * MINUTE);
  assert.equal(statesOf(s.gladys, 'power').length, 41);
  assert.doesNotMatch(status(s).message.en, /have not changed/);
});

test('r1-8: a pause runs on the monotonic clock, whatever the wall clock does', async () => {
  let busy = true;
  const gw = createGateway((path) =>
    busy && path === '/api' ? new Response('x', { status: 429 }) : defaults[path]?.(),
  );
  const wall = { offset: 0 };
  const s = await setup({ gw, wall });
  await s.start();
  assert.match(status(s).message.en, /asks to wait/);
  busy = false;
  wall.offset = -3 * 24 * 3_600_000; // the wall clock goes back 3 days
  await s.wait(2 * MINUTE);
  assert.ok(gw.net.calls.length > 1, 'read again after the minute of the pause');
  assert.equal(status(s).connected, true);
});

test('r1-8: a pause read back from /data is capped to 6 h', async () => {
  const store = createMemoryStore({
    pause: { until: NOW + 400 * 24 * 3_600_000, count: 1, code: 'server', status: 503 },
  });
  const gw = createGateway();
  const s = await setup({ gw, store });
  await s.start();
  assert.match(status(s).message.en, /new try in 6 h/);
  await s.wait(6 * 3_600_000);
  assert.ok(gw.net.calls.length > 0);
});

test('r1-9: the status counts the meters really read', async () => {
  const gw = gatewayWith({ '/api/measurement/0': () => new Response('x', { status: 500 }) });
  const s = await setup({ gw });
  await s.start();
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /answers, but none of its 1 meter\(s\) could be read/);
  assert.doesNotMatch(status(s).message.en, /the other meters are read/);
});

test('r1-10: the test button shows the index sent, a held one said so', async () => {
  let wh = 9_000_000;
  const gw = gatewayWith({ '/api/counter/0': () => counter({ importWh: wh }) });
  const s = await setup({ gw, devices: [created({ index: { value: 9000, at: NOW - MINUTE } })] });
  await s.start();
  wh = 900_000_000;
  await s.wait(MINUTE);
  const answer = await s.app.testConnection();
  assert.match(answer.en, /index 900000 kWh \(held back\)/);
  assert.match(answer.fr, /index 900000 kWh \(retenu\)/);
});

test('r1-11: the 8-bit tag of a refused password cannot give it back', () => {
  const salt = 'a'.repeat(32);
  const tag = tagOf(salt, '4821');
  let candidates = 0;
  for (let n = 0; n < 10_000; n += 1) {
    if (tagOf(salt, String(n).padStart(4, '0')) === tag) candidates += 1;
  }
  assert.ok(candidates >= 15 && candidates <= 80, `${candidates} PINs share the tag`);
});

test('r1-12: a meter leaving the list leaves Discovery; beyond 16, a note', async () => {
  let meters = twoMeters;
  const gw = createGateway((path) => {
    if (path === '/api/devices') return devices(meters);
    if (path.startsWith('/api/measurement/')) return measurement();
    if (path.startsWith('/api/counter/')) return counter();
    return defaults[path]?.();
  });
  const s = await setup({ gw });
  await s.start();
  assert.equal(s.gladys.fake.discoveredDevices.length, 2);
  meters = [twoMeters[0]];
  await s.wait(30 * SECOND);
  assert.deepEqual(
    s.gladys.fake.discoveredDevices.map((d) => d.external_id),
    [`ext:iskra:meter:${SERIAL_A}`],
  );
  meters = Array.from({ length: 18 }, (_, i) => ({ model: 'IE38', serial: `700${i + 10}` }));
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /2 meter\(s\) beyond the first 16 are not read/);
});

test('r1-13: a clean stop writes /data', async () => {
  const store = createMemoryStore();
  const s = await setup({ store, gw: createGateway(() => 'timeout') });
  await s.start();
  s.app.lastAttemptAt = NOW + 5;
  await s.app.stop();
  assert.equal(store.data.lastAttemptAt, NOW + 5);
});

// --- Review r2 ---------------------------------------------------------------------

/** A gateway of `count` meters; `page(n)` is called for each measurement page of meter n. */
function manyMeters(count, page = () => measurement()) {
  const meters = Array.from({ length: count }, (_, i) => ({
    model: 'IE38',
    serial: `${80000 + i}`,
  }));
  const gw = createGateway((path) => {
    if (path === '/api') return gateway();
    if (path === '/api/devices') return devices(meters);
    const m = /^\/api\/measurement\/(\d+)$/.exec(path);
    if (m) return page(Number(m[1]));
    if (path.startsWith('/api/counter/')) return counter();
    return undefined;
  });
  return { meters, gw };
}

test('r2-16: a slow gateway: every meter is read in turn, none is starved', async () => {
  const { meters, gw } = manyMeters(16, () => {
    gw.clock.now += 8 * SECOND; // a slow page
    return measurement();
  });
  const s = await setup({ gw, devices: meters.map((m) => created(m)) });
  await s.start();
  await s.wait(30 * MINUTE);
  for (const m of meters) {
    assert.ok(statesOf(s.gladys, 'power', m.serial).length > 0, `${m.serial} read`);
  }
});

test('r2-16: dead meters at the head of the list never starve the others', async () => {
  const { meters, gw } = manyMeters(16, (n) => {
    if (n < 6) {
      gw.clock.now += 10 * SECOND;
      return 'timeout';
    }
    return measurement();
  });
  const s = await setup({ gw, devices: meters.map((m) => created(m)) });
  await s.start();
  await s.wait(30 * MINUTE);
  for (const m of meters.slice(6)) {
    assert.ok(statesOf(s.gladys, 'power', m.serial).length > 0, `${m.serial} read`);
  }
});

test('r2-17: a 429 at the end of a long round: the pause counts from the 429', async () => {
  let lists = 0;
  let at429;
  const gw = createGateway((path) => {
    if (path === '/api/devices') {
      lists += 1;
      if (lists === 2) {
        gw.clock.now += 63 * SECOND; // the second list answers 63 s into the round
        at429 = gw.clock.now;
        return new Response('x', { status: 429 });
      }
    }
    return defaults[path]?.();
  });
  const s = await setup({ gw });
  await s.start();
  const before = gw.net.calls.length;
  const requests = [];
  const real = gw.world;
  gw.world = (path, t, init) => {
    requests.push(t);
    return real(path, t, init);
  };
  await s.wait(59 * SECOND);
  assert.equal(gw.net.calls.length, before, 'nothing within the minute after the 429');
  await s.wait(2 * SECOND);
  // The test clock drifts by microseconds per read of the monotonic clock.
  assert.ok(requests.length > 0 && requests[0] >= at429 + MINUTE - 1);
});

test('r2-19: a page with the total power alone is never called frozen', async () => {
  const gw = gatewayWith({
    '/api/measurement/0': () => ({ measurements: { Total: { P: '0 W' } } }),
  });
  const s = await setup({ gw, devices: [created()] });
  await s.start();
  await s.wait(20 * MINUTE);
  assert.doesNotMatch(status(s).message.en, /have not changed/);
  assert.ok(statesOf(s.gladys, 'power').length > 0);
});

test('r2-21: a stop writes /data before waiting for the read running', async () => {
  const gw = createGateway();
  const store = createMemoryStore();
  const s = await setup({ gw, store });
  gw.net.hold = true;
  await s.app.start(CONFIG);
  const running = s.advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  s.app.lastAttemptAt = NOW + 7;
  const stopping = s.app.stop();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.data.lastAttemptAt, NOW + 7, 'saved before waiting');
  gw.net.hold = false;
  gw.net.release();
  await running;
  await stopping;
});
