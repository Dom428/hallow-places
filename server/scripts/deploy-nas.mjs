// Sends Hallow Places (server/) to your NAS over SSH and (re)starts it with Docker Compose - the same idea as Hallow
// Assist's deploy-nas.mjs. It uses the SSH key you already set up for the NAS, never touches your Cloudflare tunnel,
// DNS or other containers, never overwrites the .env file on the NAS, and never touches the data volume.
//
//   node scripts/deploy-nas.mjs [--dry-run]
//
// Settings: environment variables, or server/deploy.env (not in git) with lines like
//   NAS_HOST=192.168.1.20          the NAS on your home network
//   NAS_USER=me                    the SSH account
//   NAS_DIR=/volume1/docker/hallow-places
//   SSH_KEY=C:\Users\me\.ssh\nas_key        (default: ~/.ssh/id_ed25519)
//   PUBLIC_URL=https://places.example.com   (written to the NAS .env only if there is none yet)
//   TZ=America/New_York                     (likewise; only read from deploy.env)
//   DOCKER=sudo docker             if your NAS needs sudo for docker (default: docker)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry-run');
const fileEnv = {};
const envFile = path.join(SERVER, 'deploy.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) fileEnv[m[1]] = m[2]; }
const get = (k, d) => process.env[k] || fileEnv[k] || d;
const host = get('NAS_HOST'), user = get('NAS_USER'), dir = get('NAS_DIR', '/volume1/docker/hallow-places');
const key = get('SSH_KEY', path.join(os.homedir(), '.ssh', 'id_ed25519'));
const publicUrl = get('PUBLIC_URL', ''), tz = fileEnv.TZ || '', docker = get('DOCKER', 'docker');
if (!dry && (!host || !user)) { console.error('Set NAS_HOST and NAS_USER (environment or server/deploy.env). See NAS-DEPLOY.md.'); process.exit(2); }
if (!/^[\w./-]+$/.test(dir)) { console.error('NAS_DIR may only contain letters, digits, . _ / -'); process.exit(2); }
if (publicUrl && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(publicUrl)) { console.error('PUBLIC_URL must look like https://places.example.com'); process.exit(2); }
if (tz && !/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(tz)) { console.error('TZ must look like America/New_York'); process.exit(2); }

// only the server itself: no tests, no deploy settings, no local data
const FILES = ['package.json', 'server.js', 'lib', 'public', 'Dockerfile', 'docker-compose.yml'];
const tmp = path.join(os.tmpdir(), `hallow-places-${Date.now()}.tgz`);
execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['czf', tmp, '-C', SERVER, ...FILES], { stdio: 'inherit' });
const size = fs.statSync(tmp).size;
const envLines = [publicUrl && `PUBLIC_URL=${publicUrl}`, tz && `TZ=${tz}`].filter(Boolean);
const remote = [
  `mkdir -p '${dir}'`,
  `tar xzf - -C '${dir}'`,
  envLines.length ? `{ [ -f '${dir}/.env' ] || printf '${envLines.join('\\n')}\\n' > '${dir}/.env'; }` : 'true',
  `cd '${dir}'`,
  `${docker} compose up -d --build`,
].join(' && ');
const sshArgs = ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${user || 'USER'}@${host || 'NAS'}`, remote];
if (dry) {
  console.log(`Package: ${(size / 1024).toFixed(0)} KB (${FILES.join(', ')})`);
  console.log('Would run: ssh ' + sshArgs.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ') + ' < package');
  fs.rmSync(tmp, { force: true });
  process.exit(0);
}
const r = spawnSync('ssh', sshArgs, { input: fs.readFileSync(tmp), stdio: ['pipe', 'inherit', 'inherit'] });
fs.rmSync(tmp, { force: true });
if (r.status !== 0) { console.error(`SSH or Docker failed (exit ${r.status}). Nothing else was changed.`); process.exit(1); }
console.log(`Sent ${(size / 1024).toFixed(0)} KB; Hallow Places is starting on ${host}:8091.`);
console.log(`First start? The one-time setup code for the admin password is in: ssh ${user}@${host} "${docker} logs hallow-places"`);
const urls = [`http://${host}:8091/healthz`, ...(publicUrl ? [publicUrl + '/healthz'] : [])];
for (const u of urls) {
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) { await new Promise(res => setTimeout(res, 3000)); ok = await fetch(u).then(x => x.ok).catch(() => false); }
  console.log(ok ? `OK  ${u}` : `NO ANSWER  ${u}` + (u.startsWith('https') ? '  (the tunnel route or DNS record may not be set up yet - see NAS-DEPLOY.md)' : ''));
}
