# Private co-op relay

A friends-only server for trainsworld: a login, a list of open games, and a relay that carries the co-op messages
between browsers. It also serves the built game and the game's data, so one service is all a proxy has to route to.
Nothing is visible without a session: every other request answers a bare 404.

```
browser ── https :443 ──> Traefik (or any proxy) ──> relay (one service, one port)
                                                       ├─ /<secret-login>          the sign-in page (public)
                                                       ├─ /api/*, /ws              lobby and relay (friends)
                                                       ├─ /packs/, /noritetsu/     game data, fetched once and cached
                                                       └─ everything else          the built game
```

No port besides 443 is opened.

## What the relay does

- `POST /api/login {code}` — an invite code names the friend (`TW_INVITES="alice:code1,bob:code2"`), a signed
  HttpOnly cookie follows. Five wrong codes block an address for ten minutes.
- `GET/POST /api/games`, `DELETE /api/games/:id` — the lobby. A game is a room; only its creator can be its host.
- `/ws?room=ID&role=host|guest` — a room's WebSocket. Every frame goes to every other member; nothing is stored.
  A room goes when its host leaves, or stays away for `TW_GRACE_S` (90) seconds.
- With `TW_STATIC_DIR` set: the built game (`app/dist`) for friends, with the line that points the page at this relay
  added to its `index.html`; and `/packs/…`, `/noritetsu/…` fetched from the original developer's data server on the
  first request and kept in `TW_DATA_CACHE` (a session fetches tens of MB; the full data is 6 GB and not needed).
- `GET /api/auth` — 204 for a friend, 401 otherwise, for proxies that gate other services by a sub-request (nginx
  `auth_request`, Traefik `forwardAuth`). Not needed when the relay serves the game itself.

The host's browser is the authority and every browser runs its own simulation (`app/src/game/coop.ts`), so the relay
needs very little: a few MB when a guest joins (the saved game), then small messages.

## Settings (environment)

| name | meaning |
|---|---|
| `TW_INVITES` | `name:code,name:code` — one per friend; remove one to revoke it |
| `TW_SECRET` | signs the cookies; set it, or every restart signs everyone out |
| `TW_LOGIN_PATH` | the sign-in page's address, `/login` by default: make it a long secret like `/x7k2p9q4` |
| `TW_SECURE=1` | cookie only over https (set this behind https) |
| `TW_TRUST_PROXY=1` | take the client address from `X-Forwarded-For` (set behind a proxy) |
| `TW_STATIC_DIR` | the built game, `app/dist` |
| `TW_DATA_VERSION` | the line in `trainworld/data-version.txt` (read from there when the file is beside the relay's folder) |
| `TW_DATA_ORIGIN`, `TW_DATA_CACHE` | the data server (`https://data.anita.garden`), where fetched data is kept (`./data-cache`) |
| `TW_GRACE_S` | seconds a room outlives its host's connection (90) |
| `PORT`, `BIND` | `8787`, `127.0.0.1` (`0.0.0.0` inside a container) |
| `TW_ORIGINS` | development only: a page on another port may call the API |

## Try it locally

```bash
cd trainworld/relay && npm install && npm test                 # 11 checks: login, hiding, rooms, relaying, files
cd ../app && npm run build                                      # wasm, type check, vite build -> app/dist
cd ../relay && TW_INVITES="alice:a1,bob:b2" TW_SECRET=dev TW_LOGIN_PATH=/door-7391 TW_STATIC_DIR=../app/dist node server.mjs
```

Open `http://localhost:8787/door-7391`, enter `a1`, you land in the game. Co-op button → Online → host a game; open
the same address in a second tab and join it from the list.

While developing the page with `npm run dev`, run the relay with `TW_ORIGINS=http://localhost:5173` and open
the dev page with `?relay=http://localhost:8787` (the address is kept for the tab).

## Deploy with Traefik

1. **Build the game** on a machine with the toolchain: `cd trainworld/app && npm install && npm run build`, and copy
   `app/dist` to the server (e.g. `/opt/trains/dist`).

2. **Docker** (the relay folder has a `Dockerfile`; this was written, not run, so expect to adjust):

   ```yaml
   # /opt/trains/compose.yml
   services:
     trains:
       build: ./relay                 # a copy of trainworld/relay
       restart: unless-stopped
       environment:
         TW_INVITES: "alice:CHANGE-ME,bob:CHANGE-ME"
         TW_SECRET: "CHANGE-ME-LONG-RANDOM"
         TW_LOGIN_PATH: "/x7k2p9q4"
         TW_SECURE: "1"
         TW_TRUST_PROXY: "1"
         TW_DATA_VERSION: "2026-11-18b"        # the line in trainworld/data-version.txt, for the build you deploy
       volumes:
         - ./dist:/app/dist:ro
         - ./data-cache:/app/data-cache         # must be writable by uid 1000 (chown 1000:1000 data-cache)
       networks: [traefik]                      # the network Traefik is on
       labels:
         - traefik.enable=true
         - traefik.http.routers.trains.rule=Host(`trains.example.org`)
         - traefik.http.routers.trains.entrypoints=websecure
         - traefik.http.routers.trains.tls.certresolver=letsencrypt   # whatever yours is called
         - traefik.http.services.trains.loadbalancer.server.port=8787
   networks:
     traefik:
       external: true
   ```

   Traefik forwards WebSockets without extra settings. Keep the codes and the secret out of the repository (an `.env`
   file, or Docker secrets).

3. **Without Docker** (relay as a systemd service, Traefik's file provider pointing at it):

   ```ini
   # /etc/systemd/system/trains-relay.service
   [Unit]
   Description=trainsworld relay
   After=network.target
   [Service]
   WorkingDirectory=/opt/trains/relay
   ExecStart=/usr/bin/node server.mjs
   EnvironmentFile=/opt/trains/relay.env        # mode 600: TW_INVITES, TW_SECRET, TW_LOGIN_PATH, ...
   Environment=TW_STATIC_DIR=/opt/trains/dist TW_SECURE=1 TW_TRUST_PROXY=1 TW_DATA_CACHE=/var/lib/trains/data
   Restart=on-failure
   User=www-data
   [Install]
   WantedBy=multi-user.target
   ```

   ```yaml
   # Traefik dynamic configuration (file provider)
   http:
     routers:
       trains:
         rule: Host(`trains.example.org`)
         entryPoints: [websecure]
         tls: { certResolver: letsencrypt }
         service: trains
     services:
       trains:
         loadBalancer:
           servers:
             - url: http://172.17.0.1:8787     # the host as Traefik's container sees it; bind the relay there
   ```

   If Traefik runs in a container, the relay must listen on an address it can reach (`BIND=172.17.0.1` or the host's
   LAN address), and a firewall rule should keep that port closed to the outside.

A stranger who opens the subdomain gets a plain 404. A friend opens `https://trains.example.org/x7k2p9q4`, enters
their code, and lands in the game with the Online section of the Co-op button already signed in.

## Good to know

- A game lives while its host's tab is open; closing it ends the room. The host can save the game and host it again.
- Each player's browser runs the whole simulation: a small city is light, New York needs several GB per tab.
- "Host only" settings (sandbox, side switch) are enforced in the browser, not by the relay. Fine among friends.
- A guest that loses its connection reconnects by itself and asks the host for the edits it missed.
- The game's data comes through your server from the original developer's, and is cached; a new game version (a new
  line in `data-version.txt`) means setting `TW_DATA_VERSION` to it and rebuilding `dist`.
- AGPL: friends using the game over the network are users, so link the source (your public fork) from somewhere they
  can see it, and replace the name, logo and the Ko-fi/Discord links, which belong to the original project.
