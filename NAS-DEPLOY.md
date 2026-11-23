# Running Hallow Places on your NAS (Docker + Cloudflare Tunnel)

Hallow Places is a small **server** you run yourself. The family's phones (the free OwnTracks app) send their position to
it, and everyone opens its web page to see the map. It keeps everything in one Docker volume on your NAS and sends
nothing anywhere except the alerts you set up (your Discord webhook and/or ntfy topic) and map-tile requests from the
viewers' browsers.

What you need:

- A machine that runs Docker - most NAS boxes (Synology, UGREEN UGOS, QNAP, Unraid), a mini PC or a Raspberry Pi.
  It uses about 40 MB of memory.
- An `https://` address that works from anywhere, because phones post from mobile data. The easy way is a
  **Cloudflare Tunnel** (free) - the same kind you use for Hallow Assist's relay. A reverse proxy with a certificate
  (Caddy, Nginx Proxy Manager, Traefik) works too.

The examples use `places.hallowservices.com`; put your own hostname wherever you see it.

## 1. Start it on the NAS

Copy the `server` folder from the release zip (or this repo) to the NAS, for example to
`/volume1/docker/hallow-places`, then in that folder:

```
docker compose up -d --build
docker logs hallow-places
```

The log shows a **one-time setup code**. Check it from your PC: `http://<NAS address>:8091/healthz` should show
`{"ok":true,...}`. Port 8091 on the NAS is only for your home network and for the tunnel - don't forward it on your
router.

Optional, in a file called `.env` next to `docker-compose.yml` (the deploy script never overwrites it):

```
PUBLIC_URL=https://places.hallowservices.com
TZ=America/New_York
```

`TZ` is the time zone for rules like "hasn't left Home by 08:15", quiet hours and the daily history files (read on the
first start; change it later on the Admin page). The data lives in the Docker volume `hallow-places-data`
(`docker volume inspect hallow-places-data` shows where; back that folder up if you want to keep history).

### Or: from your PC with the deploy script

If you can already sign in to the NAS with an SSH key, `server/scripts/deploy-nas.mjs` does the copying and the
`docker compose up` for you. Create `server/deploy.env` (it's ignored by git):

```
NAS_HOST=<NAS address on your home network, e.g. 192.168.1.20>
NAS_USER=<your SSH account on the NAS>
NAS_DIR=/volume1/docker/hallow-places
SSH_KEY=<path to the private key you use for the NAS>
PUBLIC_URL=https://places.hallowservices.com
TZ=America/New_York
# DOCKER=sudo docker     (only if docker needs sudo on your NAS)
```

Then `node server/scripts/deploy-nas.mjs --dry-run` shows what it would do, and `node server/scripts/deploy-nas.mjs`
does it. It only writes into `NAS_DIR`, never overwrites the `.env` there, never touches the data volume, the tunnel,
DNS or other containers. Run it again for each new version.

If docker on your NAS needs `sudo` with a password, the script can't type it: copy the folder yourself (File Station,
`scp`) and run `sudo docker compose up -d --build` in an SSH session.

## 2. Give it an https address (Cloudflare Tunnel)

**If your tunnel is managed in the Cloudflare dashboard** (Zero Trust > Networks > Tunnels > your tunnel >
Public Hostname > Add): subdomain `places`, domain `hallowservices.com`, service type `HTTP`, URL `<NAS address>:8091`.
Cloudflare adds the DNS record for you. Done.

**If your tunnel uses a local `config.yml`** (a `cloudflared` container with `tunnel:` and `credentials-file:` lines,
like the one Hallow Assist's relay uses):

1. Add a rule **above** the last catch-all line (`- service: http_status:404`):

   ```yaml
     - hostname: places.hallowservices.com
       service: http://<NAS address>:8091
   ```

   (If the container shares a Docker network with `cloudflared`, `http://hallow-places:8080` works too.)
2. Add the DNS record: either `cloudflared tunnel route dns <tunnel name or id> places.hallowservices.com`, or in the
   Cloudflare dashboard > DNS > Add record: type `CNAME`, name `places`, target `<tunnel id>.cfargotunnel.com`,
   Proxied (orange cloud).
3. Put the updated `config.yml` where your `cloudflared` reads it and restart that container.

Don't put Cloudflare Access (a login page) in front of it: the OwnTracks app can't get past it. Hallow Places has its
own protection: per-person passwords (scrypt) for the web page, a long random token per phone (only its hash is
stored), optional payload encryption, and limits on failed sign-ins per visitor (`TRUST_PROXY=cloudflare` counts them
per real visitor).

Check: `https://places.hallowservices.com/healthz` answers, and `https://places.hallowservices.com/` shows the sign-in
page. Then set `PUBLIC_URL=https://places.hallowservices.com` in the `.env` on the NAS and run `docker compose up -d`
again (or set **Public address** on the Admin page) - it goes into the phones' setup QR codes.

## 3. Set it up

1. Open `https://places.hallowservices.com`, type the setup code from `docker logs hallow-places` and choose the admin
   password (10+ characters). (Or set `ADMIN_PASSWORD` in `.env` before the first start.)
2. **Admin > People > Add a person** for everyone who agreed to share. Give them a password if they should be able to
   sign in to the map and their own sharing page.
3. **Phone setup** next to each person shows a QR code. On their phone: install **OwnTracks** (App Store / Google Play),
   scan the code with the camera and open it in OwnTracks (or tap *Open in OwnTracks* / the `.otrc` download on the
   phone itself), and allow location **Always**.
4. **Places**: click the map (or type latitude / longitude), name it, pick a radius (100-200 m for a home). Phones get
   the Places as OwnTracks regions automatically.
5. **Where alerts go**: paste a Discord webhook URL (Server settings > Integrations > Webhooks) and/or an ntfy topic
   (ntfy.sh or your own ntfy server; use a long, hard-to-guess topic name, or an access token). **Send a test**.
6. **Alert rules**: arrive / leave are on for everyone by default, plus battery under 15% and no update for 12 hours.
   Add "hasn't left Home by 08:15", "hasn't arrived at School by 08:45", "stays at an unknown place for 3 hours".

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port inside the container (compose maps it to 8091 on the NAS) |
| `PUBLIC_URL` | empty | The https address, used in phone setup codes (also on the Admin page) |
| `TZ` | `UTC` | Time zone on the first start (later: Admin > Settings) |
| `TRUST_PROXY` | `cloudflare` in compose, `none` otherwise | Use `CF-Connecting-IP` for per-visitor limits - trusted only from Docker networks / this machine |
| `ADMIN_PASSWORD` | empty | Sets the admin password on the first start instead of the setup code |
| `DATA_DIR` | `/data` in Docker | Where config, state and history are kept |
| `LOG` | on | `off` = no log lines. Locations, tokens, passwords and the webhook are never logged either way |

Everything else (history kept, map tiles, accuracy and leave tuning, alert channels) is on the Admin page.

## Map tiles

The map uses **OpenStreetMap's** tiles by default, which is fine for a family's light use under the
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/): the page shows the attribution, sends
the normal browser user agent and a referrer, and only loads the tiles in view (no prefetching). For heavier use, or
if you'd rather not use OSM's servers, set **Map tiles URL** on the Admin page to another provider (or your own tile
server) - `{z}`, `{x}`, `{y}` and optionally `{s}` - and its credit line.

## Updating

Copy the new `server` folder over the old one (your `.env` and the data volume stay) and run
`docker compose up -d --build`, or run the deploy script again.
