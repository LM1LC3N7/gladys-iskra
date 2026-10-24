// -----------------------------------------------------------------------------
// The answers of the gateway -> values: formats, aliases, units, bounds,
// hostile answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measurementOf,
  numberOf,
  parseCounters,
  parseDevices,
  parseGateway,
  parseMeasurements,
  serialOf,
  slotOf,
} from '../src/iskra/model.js';
import {
  SERIAL_A,
  counter,
  devices,
  gateway,
  measurement,
  measurementObjects,
} from './fixtures/iskra.js';

test('the gateway: model and serial trimmed, anything else refused', () => {
  assert.deepEqual(parseGateway(gateway()), { model: 'SG', serial: '12345678', firmware: '1.4.2' });
  assert.equal(parseGateway({}), undefined);
  assert.equal(parseGateway({ device: { model_type: 'SG' } }), undefined);
  assert.equal(parseGateway({ device: { model_type: 'SG', serial_number: '../x' } }), undefined);
  assert.equal(parseGateway([]), undefined);
});

test('the list of meters: the right IR port dropped before counting, empty ports kept', () => {
  const ports = parseDevices(
    devices([
      { model: 'IE38MD', serial: SERIAL_A },
      { model: 'XYZ', serial: '77' },
      { model: 'MC750', serial: '' },
    ]),
  );
  assert.deepEqual(ports, [
    { position: 0, model: 'IE38MD', serial: SERIAL_A, supported: true },
    { position: 1, model: 'XYZ', serial: '77', supported: false },
    { position: 2, unreadable: true },
    { position: 3, empty: true },
  ]);
  for (const model of ['IE38', 'IE35x', 'IE14', 'WM3M4', 'WM3', 'WM1', 'MT', 'iMT', 'MC', 'iMC']) {
    assert.equal(parseDevices({ devices: [{ model, serial: '1' }] })[0].supported, true, model);
  }
  assert.equal(parseDevices({ devices: [{ model: 'SG', serial: '1' }] })[0].supported, false);
  assert.equal(parseDevices({ devices: 'x' }), undefined);
  assert.equal(parseDevices({ devices: [1] }), undefined);
  assert.equal(parseDevices({ devices: new Array(65).fill({}) }), undefined);
});

test('serials: strict, bounded; a prototype key is never read', () => {
  assert.equal(serialOf(' 41000001 '), '41000001');
  for (const bad of ['', 'a b', 'x:y', '__proto__x'.repeat(5), 12, null, '-1', '0', '00000000']) {
    assert.equal(serialOf(bad), undefined, String(bad));
  }
  const hostile = JSON.parse('{"__proto__": {"devices": [{"model":"MC","serial":"1"}]}}');
  assert.equal(parseDevices(hostile), undefined);
  assert.equal({}.devices, undefined);
});

test('a serial on two ports: both ports unreadable, never one meter of two', () => {
  const ports = parseDevices(
    devices([
      { model: 'IE38MD', serial: SERIAL_A },
      { model: 'IE38MD', serial: SERIAL_A },
      { model: 'IE14', serial: '41000009' },
    ]),
  );
  assert.deepEqual(ports.slice(0, 3), [
    { position: 0, unreadable: true, duplicate: true },
    { position: 1, unreadable: true, duplicate: true },
    { position: 2, model: 'IE14', serial: '41000009', supported: true },
  ]);
});

test('numbers: a number or a strict numeric string, never "" read as 0', () => {
  assert.equal(numberOf(12.5), 12.5);
  assert.equal(numberOf(' 12.5 '), 12.5);
  assert.equal(numberOf('1e3'), 1000);
  for (const bad of ['', ' ', 'abc', '0x10', 'Infinity', NaN, null, '1'.repeat(40), true]) {
    assert.equal(numberOf(bad), undefined, String(bad));
  }
});

test('measurements: every format pyiskra reads', () => {
  assert.deepEqual(measurementOf('230.1 V'), { value: 230.1, unit: 'V' });
  assert.deepEqual(measurementOf('0.99'), { value: 0.99, unit: '' });
  assert.deepEqual(measurementOf({ value: '5', unit: 'A' }), { value: 5, unit: 'A' });
  assert.deepEqual(measurementOf(3), { value: 3, unit: '' });
  assert.equal(measurementOf('1 2 3'), undefined);
  assert.equal(measurementOf('x'.repeat(100)), undefined);
});

test('the measurement page, strings', () => {
  const m = parseMeasurements(measurement());
  assert.equal(m.power, 1500);
  assert.equal(m.phases.length, 3);
  assert.deepEqual(m.phases[0], { voltage: 230.1, current: 2.17, power: 500 });
  assert.equal(m.powerFactor, 0.99);
  assert.equal(m.frequency, 50.01);
  assert.equal(m.temperature, 31.5);
});

test('the measurement page, objects and long names, kW converted', () => {
  const m = parseMeasurements(measurementObjects({ kw: 1.5 }));
  assert.equal(m.power, 1500);
  assert.deepEqual(m.phases, [{ voltage: 231, current: 6.5, power: undefined }]);
  assert.equal(m.frequency, 50);
  assert.equal(m.temperature, undefined);
});

test('the measurement page: unknown units and out-of-bounds values are absent', () => {
  const m = parseMeasurements({
    measurements: {
      Phases: [{ U: '230 furlongs', I: '99999999 A', P: '100' }],
      Total: { P: '5 GW', PF: '3' },
      Frequency: '50',
      Temperature: '500 °C',
    },
  });
  assert.deepEqual(m.phases[0], { voltage: undefined, current: undefined, power: undefined });
  assert.equal(m.power, undefined, 'a power without a known unit is never guessed');
  assert.equal(m.powerFactor, undefined);
  assert.equal(m.frequency, 50, 'the frequency without unit is in Hz (pyiskra default)');
  assert.equal(m.temperature, undefined);
  assert.equal(parseMeasurements({ measurements: { Phases: [{}, {}, {}, {}] } }), undefined);
  assert.equal(parseMeasurements({}), undefined);
});

test('the counters: active energy in kWh, 0 absent, resettable never read', () => {
  const c = parseCounters(counter());
  assert.deepEqual(c, [
    { direction: 'import', active: true, kwh: 9000, name: 'Counter 1' },
    { direction: 'export', active: true, kwh: 1500, name: 'Counter 2' },
    { direction: 'import', kwh: undefined, active: false, name: 'Counter 3' },
  ]);
  assert.equal(
    parseCounters({ counters: { non_resettable: [{ name: 'x\u0000y', value: 1, unit: 'Wh' }] } })[0]
      .name,
    undefined,
    'a name outside the pattern is no name',
  );
  assert.equal(slotOf(c, 'import'), 0);
  assert.equal(slotOf(c, 'export'), 1);
  const odd = parseCounters({
    counters: {
      non_resettable: [
        { value: 0, unit: 'Wh', direction: 'import' },
        { value: '12.5', unit: 'kWh', direction: 'import' },
        { value: 'x', unit: 'Wh', direction: 'export' },
        { value: 1, unit: 'MWh', direction: 'sideways' },
      ],
    },
  });
  assert.equal(odd[0].kwh, undefined, 'a register at 0 is absent');
  assert.equal(odd[1].kwh, 12.5);
  assert.equal(odd[2].kwh, undefined);
  assert.equal(odd[3].direction, undefined);
  assert.equal(slotOf(parseCounters({ counters: {} }), 'import'), undefined);
  assert.equal(parseCounters({ counters: { non_resettable: 'x' } }), undefined);
  assert.equal(parseCounters({}), undefined);
  assert.equal(parseCounters({ counters: { non_resettable: new Array(100).fill({}) } }).length, 32);
});
