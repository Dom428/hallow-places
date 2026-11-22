// Everything Hallow Places keeps, in one data folder (a Docker volume):
//   config.json            people (password hashes, phone token hashes), Places, rules, settings, admin password hash
//   state.json             last positions, geofence states, alert flags, the in-app feed
//   history/<person>/<YYYY-MM-DD>.jsonl   one line per fix, append-only; whole days are deleted after the retention
// Files are written atomically (temp file + rename). Nothing here is ever sent anywhere.
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_DEFAULTS = {
  retentionDays: 30,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '© OpenStreetMap contributors',
  tileAttributionUrl: 'https://www.openstreetmap.org/copyright',
  maxZoom: 19,
  publicUrl: '',
  timeZone: 'UTC',
  maxAccuracy: 100,
  leaveMinutes: 3,
  leaveMeters: 300,
  cooldownMinutes: 15,
  discordWebhook: '',
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
  familyInOwnTracks: true,
};

const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function createStore(dir) {
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const read = (name, def) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return def; } };
  const write = (name, obj) => {
    const f = path.join(dir, name), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, name === 'config.json' ? 2 : 0), { mode: 0o600 });
    fs.renameSync(tmp, f);
  };
  const config = read('config.json', {});
  config.people ||= []; config.places ||= []; config.rules ||= null; config.admin ||= {};
  config.settings = { ...SETTINGS_DEFAULTS, ...(config.settings || {}) };
  const state = read('state.json', {});

  let timer = null;
  const saveState = () => { if (timer) return; timer = setTimeout(() => { timer = null; write('state.json', state); }, 1000); timer.unref?.(); };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } write('state.json', state); };

  const personDir = id => { if (!ID_RE.test(id)) throw new Error('bad id'); return path.join(dir, 'history', id); };

  return {
    dir, config, state,
    saveConfig: () => write('config.json', config),
    saveState, flush,
    appendFix(id, date, fix) {
      const d = personDir(id);
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, date + '.jsonl'), JSON.stringify(fix) + '\n', { mode: 0o600 });
    },
    readDay(id, date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      let text; try { text = fs.readFileSync(path.join(personDir(id), date + '.jsonl'), 'utf8'); } catch { return []; }
      const out = [];
      for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* a half-written last line */ } }
      return out.sort((a, b) => a.tst - b.tst);
    },
    days(id) { try { return fs.readdirSync(personDir(id)).map(f => DAY_RE.exec(f)?.[1]).filter(Boolean).sort(); } catch { return []; } },
    // "delete my history": every day file of that person
    deleteHistory(id) {
      const d = personDir(id);
      let n = 0;
      try { for (const f of fs.readdirSync(d)) { if (DAY_RE.test(f)) { fs.rmSync(path.join(d, f), { force: true }); n++; } } fs.rmSync(d, { recursive: true, force: true }); } catch { }
      return n;
    },
    // retention: whole days older than `days` (by the file's date) go
    sweep(days, today) {
      const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
      let n = 0;
      let ids = []; try { ids = fs.readdirSync(path.join(dir, 'history')); } catch { }
      for (const id of ids) {
        if (!ID_RE.test(id)) continue;
        for (const day of this.days(id)) if (day < cutoff) { fs.rmSync(path.join(personDir(id), day + '.jsonl'), { force: true }); n++; }
      }
      return n;
    },
  };
}
