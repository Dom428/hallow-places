import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, SETTINGS_DEFAULTS } from '../lib/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hp-store-'));

test('defaults, config saved atomically and read back', () => {
  const dir = tmp();
  const s = createStore(dir);
  assert.equal(s.config.settings.retentionDays, 30);
  assert.equal(s.config.settings.tileUrl, SETTINGS_DEFAULTS.tileUrl);
  s.config.people.push({ id: 'mia' }); s.config.settings.retentionDays = 7; s.saveConfig();
  assert.ok(!fs.existsSync(path.join(dir, 'config.json.tmp')));
  const s2 = createStore(dir);
  assert.equal(s2.config.people[0].id, 'mia'); assert.equal(s2.config.settings.retentionDays, 7);
  s2.state.feed = [{ text: 'x' }]; s2.flush();
  assert.equal(createStore(dir).state.feed[0].text, 'x');
  fs.rmSync(dir, { recursive: true });
});

test('history: one JSONL file per person per day, appended, read back in time order; a torn last line is skipped', () => {
  const dir = tmp(), s = createStore(dir);
  s.appendFix('mia', '2026-11-16', { tst: 20, lat: 1, lon: 1 });
  s.appendFix('mia', '2026-11-16', { tst: 10, lat: 2, lon: 2 });
  s.appendFix('mia', '2026-11-17', { tst: 30, lat: 3, lon: 3 });
  fs.appendFileSync(path.join(dir, 'history', 'mia', '2026-11-17.jsonl'), '{"tst":40,"la');
  assert.deepEqual(s.readDay('mia', '2026-11-16').map(f => f.tst), [10, 20]);
  assert.deepEqual(s.readDay('mia', '2026-11-17').map(f => f.tst), [30]);
  assert.deepEqual(s.days('mia'), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(s.readDay('mia', '../../config'), []);
  assert.deepEqual(s.readDay('nobody', '2026-11-16'), []);
  assert.throws(() => s.appendFix('../evil', '2026-11-16', {}), /bad id/);
  fs.rmSync(dir, { recursive: true });
});

test('retention: whole days older than the setting are deleted, newer ones kept', () => {
  const dir = tmp(), s = createStore(dir);
  for (const d of ['2026-10-01', '2026-10-16', '2026-10-17', '2026-11-15', '2026-11-16']) { s.appendFix('mia', d, { tst: 1 }); s.appendFix('leo', d, { tst: 1 }); }
  assert.equal(s.sweep(30, '2026-11-16'), 4);   // cutoff 2026-10-17: 10-01 and 10-16 go, for both
  assert.deepEqual(s.days('mia'), ['2026-10-17', '2026-11-15', '2026-11-16']);
  assert.equal(s.sweep(1, '2026-11-16'), 2);
  assert.deepEqual(s.days('leo'), ['2026-11-15', '2026-11-16']);
  fs.rmSync(dir, { recursive: true });
});

test('delete my history: every day file of that person, nobody else\'s', () => {
  const dir = tmp(), s = createStore(dir);
  s.appendFix('mia', '2026-11-15', { tst: 1 }); s.appendFix('mia', '2026-11-16', { tst: 1 }); s.appendFix('leo', '2026-11-16', { tst: 1 });
  assert.equal(s.deleteHistory('mia'), 2);
  assert.deepEqual(s.days('mia'), []); assert.ok(!fs.existsSync(path.join(dir, 'history', 'mia')));
  assert.deepEqual(s.days('leo'), ['2026-11-16']);
  assert.equal(s.deleteHistory('mia'), 0);
  fs.rmSync(dir, { recursive: true });
});
