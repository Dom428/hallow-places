// Pushes: a Discord webhook and/or an ntfy topic, both set by the admin. The webhook URL and ntfy token are secrets:
// they're never logged, never sent to the browser (the admin page only learns whether they're set) and never in errors.
export function createNotifier({ settings, log = () => {}, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  async function post(url, init, what) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return true;
        log(`${what} answered HTTP ${r.status}`);
        if (r.status < 500 && r.status !== 429) return false;
      } catch (e) {
        log(`${what} could not be reached (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
      }
      await new Promise(res => setTimeout(res, 3000));
    }
    return false;
  }

  async function discord(text, s) {
    return post(s.discordWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Hallow Places', content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    }, 'Discord webhook');
  }

  async function ntfy(title, text, kind, s) {
    const base = String(s.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = { 'Title': title, 'Tags': TAGS[kind] || 'round_pushpin', 'Priority': ['notLeft', 'notArrived', 'noUpdate'].includes(kind) ? '4' : '3' };
    if (s.ntfyToken) headers.Authorization = 'Bearer ' + s.ntfyToken;
    if (s.publicUrl) headers.Click = s.publicUrl + '/';
    return post(`${base}/${encodeURIComponent(s.ntfyTopic)}`, { method: 'POST', headers, body: text }, 'ntfy');
  }

  // returns { discord: true|false|null, ntfy: true|false|null } (null = not set up)
  async function send(alert) {
    const s = settings();
    const title = 'Hallow Places';
    const [d, n] = await Promise.all([
      validUrl(s.discordWebhook) ? discord(alert.text, s) : null,
      s.ntfyTopic && validUrl(s.ntfyServer || 'https://ntfy.sh') ? ntfy(title, alert.text, alert.kind, s) : null,
    ]);
    return { discord: d, ntfy: n };
  }
  return { send };
}

const TAGS = { arrive: 'house', leave: 'wave', notLeft: 'hourglass', notArrived: 'hourglass', battery: 'battery', noUpdate: 'grey_question', stationary: 'round_pushpin', test: 'white_check_mark' };

export function validUrl(u) {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
}
