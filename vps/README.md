# Deploy MemoryCore on a VPS with Docker

Runs the **memory-core** gateway (the API the pi extension calls) plus the
**memory-hub** management panel (optional human-facing UI) in Docker, with
persistent storage, Bearer auth, and your LLM key for memory extraction.

What's included / what's not:

| Component | Port | Status |
|-----------|------|--------|
| `memory-core` | 8420 | ✅ required — the API the extension calls |
| `memory-hub` (panel + knowledge) | 8125/8424 | ✅ included — web UI for teams/agents/skills/wikis |
| `memory-proxy` (Claude Code/CodeBuddy proxy) | 8096 | ❌ not included — only for proxied coding agents |

This folder is self-contained — copy **this folder** to the VPS, nothing else
from the repo. The image tag is pinned (`:1.0.0`); the upstream project's
Docker Hub namespace is not a Docker-verified publisher, so pinning prevents
surprise `latest` changes. If you want zero trust in the image, build from
source instead (`MemoryCore/Dockerfile` in the upstream repo).

## 1. Get the folder onto the VPS

```bash
# From your local machine:
scp -r "C:\Users\Ken\Documents\Git\tencentdb-extension\vps" user@<VPS_IP>:/home/user/

# On the VPS:
cd ~/vps
```

## 2. VPS prerequisites

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

Outbound HTTPS to your LLM provider is also required (memory extraction calls it).

## 3. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Fill in:

- `TDAI_BIND_IP` — your VPS's NetBird mesh IP (`netbird status`, e.g.
  `100.95.5.214`). All published ports (8420/8125/8424) bind to it, so nothing
  is reachable from the public internet. Leave empty only if you're using a
  firewall/Caddy instead.
- `TDAI_GATEWAY_API_KEY` — **long random hex** (`openssl rand -hex 32`). This is
  the token your pi extension authenticates with. On a VPS, do not leave it empty.
- `TDAI_LLM_*` — any OpenAI-compatible endpoint + key + model for the L1/L2/L3
  extraction pipeline. DeepSeek is cheap and works well here.

## 4. Start

```bash
docker compose up -d
docker compose ps          # STATUS should be Up (healthy)
docker compose logs -f     # watch first-boot extraction warmup
```

Health checks from the VPS itself (replace `127.0.0.1` with your mesh IP if
`TDAI_BIND_IP` is set — the ports only listen there):

```bash
curl http://<BIND_IP>:8420/health      # memory-core
curl http://<BIND_IP>:8125/            # memory-hub panel
```

## 5. Open the firewall

Pick one:

**A. NetBird mesh (recommended for this setup):** set `TDAI_BIND_IP` in `.env`
to the mesh IP, then let the mesh through:

```bash
sudo ufw allow in on wt0 to any port 8420,8125,8424 proto tcp   # wt0 = netbird interface
```

**B. Restrict by IP (no mesh, no TLS):** leave `TDAI_BIND_IP` empty and allow
only your office/home public IPs:

```bash
sudo ufw allow from <OFFICE_PUBLIC_IP> to any port 8420,8125,8424 proto tcp
sudo ufw allow from <HOME_PUBLIC_IP>   to any port 8420,8125,8424 proto tcp
```

**C. Public + TLS:** set `TDAI_BIND_IP=127.0.0.1`, put Caddy in front, expose
only 443:

```
# /etc/caddy/Caddyfile — Caddy auto-provisions the Let's Encrypt cert
memory.example.com {
    reverse_proxy 127.0.0.1:8420
}
panel.example.com {
    reverse_proxy 127.0.0.1:8125
}
```

```bash
sudo apt-get install -y caddy && sudo systemctl reload caddy
sudo ufw allow 80,443/tcp
```

## 6. Verify auth works end-to-end

```bash
curl -sS -X POST http://<VPS_IP>:8420/v3/core/count \
  -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" \
  -H "x-tdai-service-id: default" \
  -H "Content-Type: application/json" \
  -d '{"team_id":"default","agent_id":"pi","user_id":"local"}'
# → {"code":0,"message":"ok","data":{"total":...}}
```

## 7. Point the pi extension at it

The extension lives in the sibling folder `../pi-agent/`. On **every machine**
(office and home), in pi:

```
/tdmem config
```

| Prompt | Value |
|--------|-------|
| Gateway URL | `http://<VPS_IP>:8420` (or `https://memory.example.com`) |
| API key | the `TDAI_GATEWAY_API_KEY` value |
| service_id / team_id | `default` (same everywhere = shared instance) |
| agent_id | same on both machines for one continuous brain, or `office` / `home` to keep streams separate |
| user_id / session_id | anything consistent (e.g. `local` / `pi-session`) |

Or skip the wizard and set env vars: `TD_MEMORY_ENDPOINT` + `TD_MEMORY_API_KEY`
(plus optional `TD_MEMORY_AGENT_ID`).

Verify from either machine:

```
/tdmem status        # should show Health check: OK
```

## 8. Backup (mandatory — the VPS is now your single source of truth)

Nightly cron (both volumes: memory data + panel data):

```bash
docker run --rm -v tdai-memory-data:/data -v tdai-panel-data:/panel -v /backup:/backup \
  alpine tar czf /backup/tdai-$(date +%F).tar.gz -C /data tdai-memory -C /panel knowledge
```

Restore = recreate the volumes with the tar contents.

## Upgrade / stop

```bash
docker compose pull && docker compose up -d   # upgrade image, keep data
docker compose down                           # stop, keep volume
docker compose down -v                        # ⚠️ wipe data too
```

## Web management panel (memory-hub)

Included in the compose: open `http://<NETBIRD_IP>:8125` (or the Caddy URL) to
manage teams, agents, skills, and wikis, and browse the memory store. The
knowledge API is on `8424` (Swagger at `http://<NETBIRD_IP>:8424/docs`).

Notes:

- The panel authenticates to core with `REMOTE_INSTANCE_KEY` (defaults to your
  `TDAI_GATEWAY_API_KEY`). If the panel loads but shows connection/auth errors
  (`docker logs tdai-memory-hub`), the upstream panel may not be sending the
  Bearer token correctly — with the mesh/firewall in place you can safely clear
  `TDAI_GATEWAY_API_KEY` in `.env` (auth off) and restart; the pi extension
  keeps working either way.
- Nothing about the pi extension depends on the panel; it's purely the human
  UI. If you don't need it, remove the `memory-hub` service from the compose.
