// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIONS,
  INDEX_MAX_KW_DEFAULT,
  INDEX_MAX_KW_MAX,
  INDEX_MAX_KW_MIN,
} from '../src/constants.js';
import { ORDER, buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics; one version everywhere (the Release workflow owns it)', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-iskra:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-iskra');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.match(manifest.gladys_version, />=\s*5\.2\.0/);
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-iskra\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real gateway', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+une\s+vraie\s+passerelle/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+(Iskra\s+)?gateway/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+(Iskra\s+)?gateway/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code: an address, an optional login, the margin', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'address',
    'username',
    'password',
    'max_power_kw',
  ]);
  assert.equal(fields.address.type, 'string');
  assert.equal(fields.address.required, true);
  assert.equal(fields.username.type, 'string');
  assert.equal(fields.username.required, false);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.password.required, false);
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.ok(!('default' in field), `${field.key}: never a default on a secret`);
  }
  assert.equal(fields.max_power_kw.type, 'number');
  assert.equal(fields.max_power_kw.default, INDEX_MAX_KW_DEFAULT);
  assert.equal(fields.max_power_kw.min, INDEX_MAX_KW_MIN);
  assert.equal(fields.max_power_kw.max, INDEX_MAX_KW_MAX);
  assert.match(fields.password.description.en, /Kept by Gladys in its database, never shown again/);
  for (const link of fields.intro.links) {
    assert.match(link.url, /^https:\/\//);
  }
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(index.includes('onDeviceCreated'));
  assert.ok(index.includes("on('connected'"));
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  const client = read('src/iskra/client.js');
  const code = client.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ["'POST'", "'PUT'", "'DELETE'", 'https://', 'User-Agent', 'logger']) {
    assert.ok(!code.includes(word), `never ${word}`);
  }
});

test('the device: core units only, one energy index, nothing writable', () => {
  const external = {
    device: 'ext:iskra:meter:X',
    feature: (key) => `ext:iskra:meter:X:${key}`,
  };
  const device = buildDevice(
    { externalIds: () => external },
    { serial: 'X', model: 'IE38' },
    new Set(ORDER),
    '1.2.3.4',
  );
  assert.equal(device.features.length, ORDER.length);
  const units = {
    'energy-sensor': ['watt', 'kilowatt-hour', 'volt', 'ampere'],
    'device-temperature-sensor': ['celsius'],
    unknown: [undefined],
  };
  for (const feature of device.features) {
    assert.ok(units[feature.category].includes(feature.unit), feature.external_id);
    assert.equal(feature.read_only, true);
  }
  const indexes = device.features.filter((f) => ['index', 'energy'].includes(f.type));
  assert.deepEqual(
    indexes.map((f) => f.external_id),
    [external.feature('consumption_index')],
    'the injection and the tariffs are never energy indexes',
  );
  assert.deepEqual(
    device.features.filter((f) => f.category === 'energy-sensor' && f.type === 'power').length,
    1,
  );
  assert.ok(!device.features.some((f) => f.category === 'switch'));
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pyiskra/);
  assert.match(notices, /Copyright \(c\) 2025 Iskra/);
  assert.match(notices, /MIT License/);
});

test('the code never feeds the energy consumption endpoint nor scene events', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});
