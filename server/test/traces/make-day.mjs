// Writes day.jsonl: a made-up school day in OwnTracks' own message format (see schoolDay in ../helpers.mjs), kept as a
// fixed file so the geofence test replays exactly the same fixes every time. Coordinates are in the open Atlantic.
//   node test/traces/make-day.mjs
import fs from 'node:fs';
import { schoolDay } from '../helpers.mjs';
const day0 = Date.UTC(2026, 10, 16) / 1000;   // Monday 16 Nov 2026, 00:00 UTC
fs.writeFileSync(new URL('./day.jsonl', import.meta.url), schoolDay(day0).map(m => JSON.stringify(m)).join('\n') + '\n');
