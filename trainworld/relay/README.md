# Private co-op relay

A friends-only server for trainsworld: a login, a list of open games, and a relay that carries the co-op messages
between browsers. Nothing is visible without a session: every other request answers a bare 404.

```
browser ── https :443 ──> your web server (nginx / Caddy)
                              ├─ /<secret-login>, /api/*, /ws ──> relay (127.0.0.1:8787)
                              ├─ /packs/, /noritetsu/ ─────────> cached copy of the game data
                              └─ everything else ─ (only for friends) ─> the built game, static files
```

No port besides 443 is opened. The relay only listens on localhost.

## What the relay does

- `POST /api/login {code}` — an invite code names the friend (`TW_INVITES="alice:code1,bob:code2"`), a signed
  HttpOnly cookie follows. Five wrong codes block an address for ten minutes.
- `GET /api/auth` — 204 for a friend, 401 otherwise: the proxy asks this before serving a game file.
- `GET/POST /api/games`, `DELETE /api/games/:id` — the lobby. A game is a room; only its creator can be its host.
- `/ws?room=ID&role=host|guest` — a room's WebSocket. Every frame goes to every other member; nothing is stored.
  A room goes when its host stays away for `TW_GRACE_S` (90) seconds or leaves.

The host's browser is the authority and every browser runs its own simulation (see `app/src/game/coop.ts`), so the
relay needs very little: a few MB when a guest joins (the saved game), then small messages.

## Settings (environment)

| name | meaning |
|---|---|
| `TW_INVITES` | `name:code,name:code` — one per friend, revoke by removing |
| `TW_SECRET` | signs the cookies; set it, or every restart signs everyone out |
| `TW_LOGIN_PATH` | the login page's address, `/login` by default: make it a long secret like `/x7k2p9q4` |
| `TW_SECURE=1` | cookie only over https (set this behind https) |
| `TW_TRUST_PROXY=1` | take the client address from `X-Forwarded-For` (set behind the proxy) |
| `TW_GRACE_S` | seconds a room outlives its host's connection (90) |
| `PORT`, `BIND` | `8787`, `127.0.0.1` |
| `TW_ORIGINS` | only for development: a page on another port may call the API |

## Try it locally

```bash
cd trainworld/relay && npm install && npm test          # checks login, hiding, rooms, relaying
TW_INVITES="alice:a1,bob:b2" TW_SECRET=dev TW_ORIGINS=http://localhost:5173 node server.mjs
```

Then open the game's dev server with `?relay=http://localhost:8787` (the address is kept for the tab), open the
Co-op button, sign in with a code, host a game. In a second tab with the same address, join it from the list.

## Deploy

1. **Build the game** (on any machine with the toolchain; see the repo's main README):

   ```bash
   cd trainworld/app && npm install && npm run build      # wasm, type check, vite build -> app/dist
   ```

   In `dist/index.html` add, inside `<head>`, the line that makes the page look for the relay on its own site:

   ```html
   <meta name="tw-relay" content="">
   ```

   Do **not** add the `tw-data` meta: the game then reads its data from `packs/` on your own site (next point).

   Copy `dist/` to the server, e.g. `/var/www/trains`.

2. **The game's data** (6 GB, of which a session fetches tens of MB) comes from the original developer's server. Let
   your proxy fetch and cache it, so the browsers only talk to your site. The dev server does the same
   (`app/vite.config.ts`, `dataFallback`). `VERSION` is the line in `trainworld/data-version.txt`.

3. **The relay**: `cd relay && npm install --omit=dev`, then run it with a systemd unit (below).

4. **The proxy** (nginx shown; Caddy's `forward_auth` does the same job):

   ```nginx
   proxy_cache_path /var/cache/nginx/trains levels=1:2 keys_zone=trains:20m max_size=20g inactive=90d;

   server {
     listen 443 ssl http2;
     server_name trains.example.org;                 # your subdomain
     # ssl_certificate ... (as for your other sites)

     root /var/www/trains;
     error_page 401 =404 @hidden;                    # a stranger sees an ordinary 404
     location @hidden { return 404; }

     location = /_auth {                             # the proxy's question to the relay
       internal;
       proxy_pass http://127.0.0.1:8787/api/auth;
       proxy_pass_request_body off;
       proxy_set_header Content-Length "";
       proxy_set_header Cookie $http_cookie;
     }

     # the relay answers these itself and hides them from strangers
     location = /x7k2p9q4 { proxy_pass http://127.0.0.1:8787; }       # TW_LOGIN_PATH
     location /api/       { proxy_pass http://127.0.0.1:8787; proxy_set_header X-Forwarded-For $remote_addr; }
     location /ws         {
       proxy_pass http://127.0.0.1:8787;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_read_timeout 1h;
     }

     # the game's data: fetched from the original server once, then served from the cache (friends only)
     location /packs/terrain-world/ {
       auth_request /_auth;
       proxy_pass https://data.anita.garden/trainworld/terrain-world/v2/;
       proxy_ssl_server_name on;
       proxy_cache trains; proxy_cache_valid 200 206 90d; proxy_cache_key $uri$http_range;
       proxy_set_header Range $http_range;
     }
     location /packs/ {
       auth_request /_auth;
       proxy_pass https://data.anita.garden/trainworld/VERSION/;      # the version from data-version.txt
       proxy_ssl_server_name on;
       proxy_cache trains; proxy_cache_valid 200 206 90d; proxy_cache_key $uri$http_range;
       proxy_set_header Range $http_range;
     }
     location /noritetsu/ {
       auth_request /_auth;
       proxy_pass https://data.anita.garden;
       proxy_ssl_server_name on;
       proxy_cache trains; proxy_cache_valid 200 206 90d; proxy_cache_key $uri$http_range;
       proxy_set_header Range $http_range;
     }

     # the game itself
     location / {
       auth_request /_auth;
       try_files $uri /index.html;
     }
   }
   ```

   A stranger who opens the subdomain gets a plain 404. A friend opens `https://trains.example.org/x7k2p9q4`, enters
   their code, and lands in the game. Because the game page itself is behind the check, the Co-op button's Online
   section finds the cookie already set.

5. **systemd** (`/etc/systemd/system/trains-relay.service`):

   ```ini
   [Unit]
   Description=trainsworld relay
   After=network.target

   [Service]
   WorkingDirectory=/opt/trainsworld/relay
   ExecStart=/usr/bin/node server.mjs
   Environment=TW_INVITES=alice:CHANGE-ME,bob:CHANGE-ME
   Environment=TW_SECRET=CHANGE-ME-LONG-RANDOM
   Environment=TW_LOGIN_PATH=/x7k2p9q4
   Environment=TW_SECURE=1
   Environment=TW_TRUST_PROXY=1
   Restart=on-failure
   User=www-data

   [Install]
   WantedBy=multi-user.target
   ```

   Keep the invite codes and the secret out of the repository (an `EnvironmentFile=` with mode 600 works too).

## Good to know

- A game lives while its host's tab is open; closing it ends the room. The host can save the game and host it again.
- Each player's browser runs the whole simulation: a small city is light, New York needs several GB per tab.
- "Host only" settings (sandbox, side switch) are enforced in the browser, not by the relay. Fine among friends.
- A guest that loses its connection reconnects by itself and asks the host for the edits it missed.
- The data download goes through your proxy to the original developer's server; keep the cache so it is fetched once.
- AGPL: friends using the game over the network are users, so link the source (your public fork) from somewhere they
  can see it, and replace the name, logo and the Ko-fi/Discord links, which belong to the original project.
