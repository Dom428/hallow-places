# Running Hallow Places on your NAS (Docker + Cloudflare Tunnel)

Hallow Places is a small **server** you run yourself. The family's phones (the free OwnTracks app) send their position to
it, and everyone opens its web page to see the map. It keeps everything in one Docker volume on your NAS and sends
nothing anywhere except the alerts you set up (your Discord webhook and/or ntfy topic) and map-tile requests (see
[Map tiles](#map-tiles-street-satellite-hybrid)).

**Want to look first?** Demo mode shows a made-up family moving on the map, with made-up Places and alerts - on the
NAS (`DEMO=1` in `.env`, or Admin > Demo mode) or on any PC with Node 20+: in the `server` folder run
`DEMO=1 node server.js` (PowerShell: `$env:DEMO='1'; node server.js`), open `http://localhost:8080` and choose
**Look at the demo**. Nothing is installed and nothing of the demo is written to disk.

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
   Add "hasn't left Home by 08:15", "hasn't arrived at School by 08:45", "stays at an unknown place for 3 hours",
   and schedules: "arrives at School, only on school days" (Mon-Fri, not on the holidays listed under Settings).

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
| `DEMO` | off | `1` = demo mode: the map shows a made-up family instead of the real one (real data is kept, just hidden; the demo is never pushed or saved). Off by default - leave it off once the family uses it |

Everything else (history kept, map style and satellite source, the tile cache, demo mode, arrive / leave tuning,
holidays, alert channels) is on the Admin page.

## Map tiles: Street, Satellite, Hybrid

Everyone can switch the map between **Street**, **Satellite** and **Hybrid** (satellite with place names and roads);
the admin picks which one new viewers see first (Admin > Map; Street by default). Each map shows its sources' credits
in the corner, as their terms require.

| Source | Key | What you get | Terms (check the provider's page) |
|---|---|---|---|
| **OpenStreetMap** (Street, default) | none | The standard street map | Free; credit "(c) OpenStreetMap contributors"; light use, a real User-Agent, honour caching, no bulk downloads ([policy](https://operations.osmfoundation.org/policies/tiles/)) |
| **EOxCloudless 2024** (Satellite default) | none | Worldwide cloud-free Sentinel-2 imagery, about 10 m per pixel: streets, parks and fields, not single houses | CC BY-NC-SA 4.0: free for personal / non-commercial use with the credit shown; commercial use needs an EOX licence ([cloudless.eox.at](https://cloudless.eox.at)) |
| **EOX overlay** (Hybrid labels) | none | Place names and roads over the imagery | Data (c) OpenStreetMap contributors, rendering (c) EOX - credit shown |
| **USGS imagery** | none | About 1 m per pixel, **the 48 US states only** | Public domain (US government); credit "USGS The National Map" |
| **Esri World Imagery** | free ArcGIS Location Platform key | Sharp imagery worldwide | Free tier 2 million basemap tiles a month; with pay-as-you-go left off, Esri stops serving instead of billing. No caching allowed |
| **MapTiler Satellite / Hybrid** | free MapTiler key | Sharp imagery worldwide, own hybrid labels | Free plan: non-commercial use with a monthly limit. No caching allowed |

**Getting a key** (only for Esri or MapTiler - the Admin page shows these steps next to the key field):

- *Esri*: sign up at [location.arcgis.com](https://location.arcgis.com) for a free ArcGIS Location Platform account >
  Content > New item > Developer credentials > **API key credentials** > privilege *Basemaps > Static basemap tiles*
  only > Referrers: your Places address > create, copy the key > paste it in Admin > Map and pick *Esri World Imagery*.
- *MapTiler*: create a free account at [cloud.maptiler.com](https://cloud.maptiler.com) > Account > Keys > create (or
  copy) a key > Allowed HTTP origins: your Places address > paste it in Admin > Map and pick *MapTiler Satellite*.

Keys are write-only on the Admin page and never in this repository or the release. A keyed source's tiles go straight
from each signed-in browser to the provider with the key in the tile address (that is how those services work), which
is why you restrict the key to your Places address. Without a key the satellite view uses EOxCloudless.

**The tile cache**: tiles from the no-key sources (OpenStreetMap, EOxCloudless, the EOX overlay, USGS) are fetched by
the server once and kept in the data volume (`/data/tiles`), as long as each provider's cache headers say (7 days when
they don't), then revalidated. The server asks each provider at most 2 tiles at a time, never the same tile twice at
once, never beyond the source's own zoom levels (the browser enlarges the last level instead), sends a User-Agent
naming Hallow Places, and only fetches what a signed-in viewer is looking at - no prefetching, and `/tiles/` isn't an
open proxy. The folder is kept under 500 MB (Admin > Map), least recently used tiles first. Turn the cache off and the
browsers load those tiles directly instead. A custom **Street map tiles URL** (Admin > Settings: `{z}`, `{x}`, `{y}`
and optionally `{s}`, plus its credit line) is always loaded directly by the browsers.

## Updating

Copy the new `server` folder over the old one (your `.env` and the data volume stay) and run
`docker compose up -d --build`, or run the deploy script again.
