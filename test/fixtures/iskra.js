// -----------------------------------------------------------------------------
// Answers of the Smart Gateway REST API, shaped after what the pyiskra
// library reads (adapters/RestAPI.py, Iskra, MIT): built, never captured on a
// real gateway (none was at hand). Serial numbers made up.
// -----------------------------------------------------------------------------

export const ADDRESS = '192.168.1.80';
export const NOW = Date.parse('2026-10-24T10:00:00Z');
export const GATEWAY_SERIAL = '12345678';
export const SERIAL_A = '41000001';
export const SERIAL_B = '41000002';

export const gateway = (serial = GATEWAY_SERIAL) => ({
  device: {
    model_type: 'SG   ',
    serial_number: ` ${serial} `,
    description: 'Main board',
    location: 'Garage',
    sw_ver: '1.4.2',
  },
});

/** The ports of the gateway: two meters, an empty port and the right IR port (dropped). */
export const devices = (meters = [{ model: 'IE38MD', serial: SERIAL_A }]) => ({
  devices: [
    { interface: 'Right IR', model: 'Not Detected', serial: '' },
    ...meters.map((m, i) => ({
      interface: `Port ${i + 1}`,
      model: m.model,
      serial: m.serial,
      description: 'Kitchen meter',
      location: 'Basement',
      sw_ver: '2.0',
    })),
    { interface: 'Port 9', model: 'Disabled', serial: '' },
  ],
});

/** A three-phase measurement page, strings "value unit" (the older format). */
export const measurement = ({ w = 1500, volts = 230.1 } = {}) => ({
  measurements: {
    Phases: [
      { U: `${volts} V`, I: '2.17 A', P: `${w / 3} W`, Q: '10 var', PF: '0.99' },
      { U: `${volts} V`, I: '2.17 A', P: `${w / 3} W` },
      { U: `${volts} V`, I: '2.17 A', P: `${w / 3} W` },
    ],
    Total: { P: `${w} W`, Q: '30 var', S: '1510 VA', PF: '0.99' },
    Frequency: '50.01 Hz',
    Temperature: '31.5 °C',
  },
});

/** The same in the newer format: objects `{ value, unit }` and long names. */
export const measurementObjects = ({ kw = 1.5 } = {}) => ({
  measurements: {
    Phases: [{ voltage: { value: 231, unit: 'V' }, current: { value: 6.5, unit: 'A' } }],
    Total: { active_power: { value: kw, unit: 'kW' } },
    frequency: { value: 50, unit: 'Hz' },
  },
});

/** The counter page: import and export active energy in Wh, a reactive one, a resettable. */
export const counter = ({ importWh = 9_000_000, exportWh = 1_500_000 } = {}) => ({
  counters: {
    non_resettable: [
      { name: 'Counter 1', value: importWh, unit: 'Wh', direction: 'import' },
      { name: 'Counter 2', value: String(exportWh), unit: 'Wh', direction: 'export' },
      { name: 'Counter 3', value: 120_000, unit: 'varh', direction: 'import' },
    ],
    resettable: [{ name: 'Counter 5', value: 12, unit: 'Wh', direction: 'import' }],
  },
});

export const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
