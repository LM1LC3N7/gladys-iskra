// -----------------------------------------------------------------------------
// The only network access: GET requests to the gateway, bounded, our error
// codes, the login only as the cookie pyiskra sends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient, authCookie } from '../src/iskra/client.js';
import { counter, devices, gateway, json, measurement } from './fixtures/iskra.js';
import { createFetch, refusedError, streamOf, timeoutError } from './helpers/fakeNet.js';

const client = (handler, login = null) => {
  const net = createFetch(handler);
  return {
    net,
    client: new GatewayClient({ address: '192.168.1.80:8080', login, fetchImpl: net.fetch }),
  };
};

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected an error');
};

test('GET of each page at the address, no redirect followed, a timeout, no cookie', async () => {
  const pages = {
    '/api': gateway(),
    '/api/devices': devices(),
    '/api/measurement/0': measurement(),
    '/api/counter/0': counter(),
  };
  const { net, client: c } = client(({ path }) => json(pages[path]));
  assert.equal((await c.gateway()).serial, '12345678');
  assert.equal((await c.devices()).length, 2);
  assert.equal((await c.measurements(0)).power, 1500);
  assert.equal((await c.counters(0))[0].kwh, 9000);
  assert.deepEqual(
    net.calls.map((call) => call.path),
    Object.keys(pages),
  );
  for (const call of net.calls) {
    assert.equal(call.host, '192.168.1.80:8080');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'manual');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers['User-Agent'], undefined);
    assert.equal(call.init.headers.Cookie, undefined, 'no login, no cookie');
  }
});

test('the login: the cookie of pyiskra, and nowhere in the client object', async () => {
  const login = { username: 'admin', password: 'iskra-pw' };
  assert.equal(
    authCookie(login),
    `Authorization=Basic ${Buffer.from('admin:iskra-pw').toString('base64')}`,
  );
  const { net, client: c } = client(() => json(gateway()), login);
  await c.gateway();
  assert.equal(net.calls[0].init.headers.Cookie, authCookie(login));
  const shown = JSON.stringify(c) + Object.keys(c).join() + String(c);
  assert.ok(!shown.includes('iskra-pw'));
  assert.ok(!shown.includes(Buffer.from('admin:iskra-pw').toString('base64')));
});

test('our error codes, never a text of the gateway', async () => {
  const cases = [
    [() => json('nope', { status: 404 }), 'not_found'],
    [() => json('secret text', { status: 403 }), 'refused'],
    [() => json('secret text', { status: 401 }), 'refused'],
    [() => json('', { status: 302, headers: { location: 'http://elsewhere/' } }), 'redirect'],
    [() => json('', { status: 418 }), 'http'],
    [() => json('', { status: 500 }), 'server'],
    [() => json('', { status: 429, headers: { 'retry-after': '120' } }), 'rate_limited'],
    [() => new Response('<html>secret</html>'), 'not_json'],
    [() => json({ hello: 'world' }), 'unknown_answer'],
    [
      () => {
        throw timeoutError();
      },
      'timeout',
    ],
    [
      () => {
        throw refusedError();
      },
      'unreachable',
    ],
  ];
  for (const [handler, code] of cases) {
    const err = await codeOf(client(handler).client.gateway());
    assert.equal(err.code, code);
    assert.ok(!/secret|html|elsewhere|192\.168/.test(err.message), err.message);
  }
  const limited = await codeOf(
    client(() => json('', { status: 429, headers: { 'retry-after': '120' } })).client.gateway(),
  );
  assert.equal(limited.retryAfter, 120_000);
});

test('a hostile answer is cut at 64 KiB', async () => {
  const err = await codeOf(
    client(() => new Response(streamOf(10_000, 1024), { status: 200 })).client.devices(),
  );
  assert.equal(err.code, 'too_large');
});

test('one request at a time', async () => {
  const { net, client: c } = client(() => json(gateway()));
  net.hold = true;
  const a = c.gateway();
  const b = c.gateway();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.calls.length, 1);
  net.hold = false;
  net.release();
  await a;
  await b;
  assert.equal(net.calls.length, 2);
});
