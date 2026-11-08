# Live session: build Omo from source on a Mac, then join Harry's room

Checked on 2026-11-08 (Linux): the host commands in Part 2 run (create-room, server health `{"ok":true}`, builder invite). A fresh clone of `master` (3783b66) installs, builds and serves on Linux
(`npm ci` → `npm run build` → `check:ide` `"ready":true` → app serves in 3 s). Nobody has done
this on a Mac yet. If a step fails, copy its last 30 lines into the thread.

## Part 1: Mac, the evening before (about 10–15 min)

```sh
# 1. Tools (skip what you already have)
xcode-select --install                      # Apple compiler, for node-pty
brew install node@22 python@3.12 tmux bash git
brew link --overwrite --force node@22
node -v; python3 -V; tmux -V                # want v22.x, 3.11+, tmux 3.x

# 2. Get the code (path must have NO spaces)
mkdir -p ~/dev && cd ~/dev
git clone --depth 1 https://github.com/omoresearch/omo-spatial-ide.git
cd omo-spatial-ide/omo

# 3. Install and build
export PUPPETEER_SKIP_DOWNLOAD=true ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild drivelist node-pty --foreground-scripts
npm run build
npm run --silent check:ide                  # want "ready":true and "unsupported":[]
npm run doctor                              # macOS warnings are expected; exit 0 is what matters

# 4. Run it on a test folder
mkdir -p ~/omo-live && echo '# live session' > ~/omo-live/README.md
npm start -- --workspace ~/omo-live --port 3190
```

Open http://127.0.0.1:3190 in Chrome. You should see the "Build a world from a sentence" screen.
Pick a template (or type a plan) → Create. Walk up to a desk, click its monitor, type `echo hi`.
Leave it running, or stop it with Ctrl+C and start it again tomorrow with the last command.

To update later: `cd ~/dev/omo-spatial-ide && git pull && cd omo && npm ci --ignore-scripts --no-audit --no-fund && npm rebuild drivelist node-pty --foreground-scripts && npm run build`.

## Part 2: Harry's PC, at the start of the session (host)

Room server on loopback, Tailscale Serve in front (tailnet only). Port 8792 (8787/8790/8791 are taken on this PC).

```sh
cd ~/dev/omo-world-v2/omo
DATA=~/.omo-rooms
node server/omo-room-server.cjs create-room --data $DATA --id live-room --name "Omo live" --owner Harry   # once; prints the OWNER KEY once
node server/omo-room-server.cjs --data $DATA --host 127.0.0.1 --port 8792 \
     --public-url https://harry-linux.tail7cc31d.ts.net:8443 --trust-proxy
tailscale serve --bg --https=8443 http://127.0.0.1:8792
```

In Harry's Omo: **Remote room** → **Host a room** → server `https://harry-linux.tail7cc31d.ts.net:8443`, owner key →
**Host room** → **Create invite link** (role **builder**) → send the "Omo app link" (the one with `/omo-room/join/`) to Kaviru privately, not in a public channel. It is single use and expires in 2 h.

After the session: `tailscale serve --https=8443 off` and stop the server (Ctrl+C).

## Part 3: Mac, during the session (join)

```sh
curl https://harry-linux.tail7cc31d.ts.net:8443/healthz      # want {"ok":true,...}
```

In your Omo: **Remote room** → **Join a remote room** → your name → paste the invite link → **Join room**.

## What we test together

1. Both see each other: presence list, avatars, walking.
2. Chat both ways.
3. Harry adds a desk in build mode → Apply → it appears for Kaviru (and the reverse).
4. Voice: both press **Turn on voice**, talk, mute/unmute, then **Voice check**.
5. Terminals stay local: what Harry types never shows on Kaviru's screen, and the reverse.
6. Leave and rejoin via **Rooms you joined before**.
7. Optional, only after a separate yes (costs money): one real Hermes or Claude Code tab at one desk.

Nothing starts an agent without a confirmation click. No terminal is shared through the room server.
