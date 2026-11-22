import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, toFix, placeForTransition, reply, friendItems, setWaypointsCmd, phoneConfig, inlineLink } from '../lib/owntracks.js';
import { encryptOwnTracks, decryptOwnTracks } from '../lib/secretbox.js';

const NOW = 1763300000;

test('parse: plain messages, garbage, and messages sealed with the person\'s key', () => {
  assert.equal(parseMessage('{"_type":"location","lat":1}').msg._type, 'location');
  assert.equal(parseMessage('{"_type":"location"}').encrypted, false);
  assert.match(parseMessage('not json').error, /JSON/);
  assert.match(parseMessage('[1,2]').error, /object/);
  assert.match(parseMessage('{"lat":1}').error, /_type/);
  assert.match(parseMessage('null').error, /object/);
  const inner = JSON.stringify({ _type: 'location', lat: 12.3456, lon: -32.1, tst: NOW });
  const sealed = JSON.stringify({ _type: 'encrypted', data: encryptOwnTracks(inner, 'k3y') });
  const r = parseMessage(sealed, 'k3y');
  assert.equal(r.encrypted, true); assert.equal(r.msg.lat, 12.3456);
  assert.match(parseMessage(sealed, 'wrong').error, /decrypt/);
  assert.match(parseMessage(sealed, '').error, /no key/);
  assert.match(parseMessage(JSON.stringify({ _type: 'encrypted', data: encryptOwnTracks('nope', 'k3y') }), 'k3y').error, /not JSON/);
});

test('location -> fix: fields kept, rounded and range-checked', () => {
  const f = toFix({ _type: 'location', lat: 12.34567891, lon: -32.1, tst: NOW, acc: 12.6, alt: 40, vel: 33, cog: 270, batt: 81, bs: 2, conn: 'w', t: 'u', tid: 'MI', SSID: 'home-wifi', inregions: ['Home'] }, NOW);
  assert.deepEqual(f, { tst: NOW, lat: 12.345679, lon: -32.1, acc: 13, alt: 40, vel: 33, cog: 270, batt: 81, bs: 2, conn: 'w', t: 'u' });
  assert.equal(toFix({ lat: '12.5', lon: '-32', tst: String(NOW) }, NOW).lat, 12.5, 'numbers as strings');
  for (const bad of [{ lat: 91, lon: 0, tst: NOW }, { lat: 1, lon: 181, tst: NOW }, { lat: 0, lon: 0, tst: NOW }, { lat: 1, lon: 1 }, { lat: 1, lon: 1, tst: 12345 }, { lat: 1, lon: 1, tst: NOW + 3600 }, { lat: 'x', lon: 1, tst: NOW }])
    assert.equal(toFix({ _type: 'location', ...bad }, NOW), null, JSON.stringify(bad));
  const f2 = toFix({ lat: 1, lon: 1, tst: NOW, acc: -5, batt: 140, bs: 9, vel: -3, conn: 'wifi' }, NOW);
  assert.deepEqual(f2, { tst: NOW, lat: 1, lon: 1 }, 'nonsense extras dropped');
});

test('transition -> fix with the event, and which Place it is about', () => {
  const places = [{ id: 'a', name: 'Home', tst: 1700000001 }, { id: 'b', name: 'School', tst: 1700000002 }];
  const f = toFix({ _type: 'transition', event: 'leave', desc: 'school', wtst: 1700000002, lat: 12.35, lon: -32.08, tst: NOW, acc: 20, t: 'c' }, NOW);
  assert.equal(f.transition, 'leave'); assert.equal(f.wtst, 1700000002);
  assert.equal(placeForTransition(f, places).id, 'b');
  assert.equal(placeForTransition({ desc: 'HOME' }, places).id, 'a', 'by name, any case');
  assert.equal(placeForTransition({ desc: 'Mall', wtst: 5 }, places), null);
  assert.equal(toFix({ _type: 'transition', event: 'wander', lat: 1, lon: 1, tst: NOW }, NOW), null);
});

test('phone config: HTTP mode, the token as password, encryption key, and the inline link decodes back', () => {
  const person = { user: 'mia', tid: 'MI', encryptionKey: 'abcdefghijklmnopqrstuvwxyz012345' };
  const c = phoneConfig({ person, device: { id: 'phone' }, token: 'T0KEN', url: 'https://places.example.com/pub' });
  assert.equal(c._type, 'configuration'); assert.equal(c.mode, 3); assert.equal(c.auth, true);
  assert.equal(c.username, 'mia'); assert.equal(c.password, 'T0KEN'); assert.equal(c.deviceId, 'phone'); assert.equal(c.tid, 'MI');
  assert.equal(c.encryptionKey, person.encryptionKey); assert.equal(c.cmd, true);
  const link = inlineLink(c);
  assert.match(link, /^owntracks:\/\/\/config\?inline=[A-Za-z0-9%]+$/);
  assert.ok(!/[+/=]/.test(link.split('=').slice(1).join('=')), 'base64 + / = are percent-encoded');
  const back = JSON.parse(Buffer.from(decodeURIComponent(link.split('inline=')[1]), 'base64').toString());
  assert.deepEqual(back, c);
  assert.equal(phoneConfig({ person: { user: 'x', tid: 'X' }, device: { id: 'p' }, token: 't', url: 'u' }).encryptionKey, undefined);
});

test('reply: family as OwnTracks friends, Places as setWaypoints, sealed when the phone sealed', () => {
  const items = friendItems({ user: 'leo', tid: 'LE', name: 'Leo' }, { lat: 12.34, lon: -32.1, tst: NOW, acc: 9, batt: 50 });
  assert.equal(items[0]._type, 'card'); assert.equal(items[0].name, 'Leo');
  assert.equal(items[1]._type, 'location'); assert.equal(items[1].tid, 'LE'); assert.equal(items[1].topic, 'owntracks/leo/hallow'); assert.equal(items[1].batt, 50);
  const cmd = setWaypointsCmd([{ name: 'Home', lat: 12.3456, lon: -32.1, radius: 120.4, tst: 1700000001 }]);
  assert.equal(cmd.action, 'setWaypoints');
  assert.deepEqual(cmd.waypoints.waypoints[0], { _type: 'waypoint', desc: 'Home', lat: 12.3456, lon: -32.1, rad: 120, tst: 1700000001 });
  assert.equal(reply(items, null), items);
  const sealed = reply(items, 'k3y');
  assert.equal(sealed[0]._type, 'encrypted');
  assert.deepEqual(JSON.parse(decryptOwnTracks(sealed[1].data, 'k3y')), items[1]);
});
