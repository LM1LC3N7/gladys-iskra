// -----------------------------------------------------------------------------
// The configuration: the address, the login (both or none), the margin.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isComplete, normalizeConfig, parseAddress } from '../src/config.js';

test('the address: IP, host, port, pasted URL; a login in it is refused', () => {
  assert.deepEqual(parseAddress(' 192.168.1.80 '), { address: '192.168.1.80' });
  assert.deepEqual(parseAddress('http://192.168.1.80:80/index.html'), { address: '192.168.1.80' });
  assert.deepEqual(parseAddress('sg.local:8080'), { address: 'sg.local:8080' });
  assert.deepEqual(parseAddress('fe80::1'), { address: '[fe80::1]' });
  assert.deepEqual(parseAddress('http://admin:pw@192.168.1.80'), { error: 'invalid' });
  assert.deepEqual(parseAddress('a b'), { error: 'invalid' });
  assert.deepEqual(parseAddress('1.2.3.4:70000'), { error: 'invalid' });
});

test('the login: both fields or none; no ":" in the user name, no control byte', () => {
  assert.equal(normalizeConfig({ address: '1.2.3.4' }).login, null);
  assert.deepEqual(
    normalizeConfig({ address: '1.2.3.4', username: ' admin ', password: 'p w' }).login,
    {
      username: 'admin',
      password: 'p w',
    },
  );
  for (const bad of [
    { username: 'admin' },
    { password: 'pw' },
    { username: 'a:b', password: 'pw' },
    { username: 'admin', password: 'p\r\nCookie: x' },
    { username: 'x'.repeat(200), password: 'pw' },
  ]) {
    const config = normalizeConfig({ address: '1.2.3.4', ...bad });
    assert.equal(config.invalidLogin, true, JSON.stringify(bad));
    assert.equal(config.login, null);
    assert.equal(isComplete(config), false);
  }
});

test('the margin of the guard: bounded, else 100 kW', () => {
  assert.equal(normalizeConfig({}).maxKw, 100);
  assert.equal(normalizeConfig({ max_power_kw: 250 }).maxKw, 250);
  assert.equal(normalizeConfig({ max_power_kw: '43.5' }).maxKw, 43.5);
  for (const bad of [0, -5, 5000, '', 'x', null, NaN]) {
    assert.equal(normalizeConfig({ max_power_kw: bad }).maxKw, 100, String(bad));
  }
});
