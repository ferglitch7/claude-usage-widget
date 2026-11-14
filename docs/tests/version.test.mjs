// The installed app reloads when version.json differs from the version it runs.
// Both must change together on every release, or every launch would reload.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('version.json matches the version in js/update.js', () => {
  const json = JSON.parse(fs.readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  const src = fs.readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
  const m = src.match(/APP_VERSION = '([^']+)'/);
  assert.ok(m, 'APP_VERSION not found');
  assert.equal(json.version, m[1]);
});
