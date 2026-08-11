# pi-tencentdb-memory

Pi coding agent extension for [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) — self-hosted team memory across machines with zero runtime dependencies.

```
pi-tencentdb-memory/
├── extensions/
│   └── tencentdb-memory.ts   ← the extension (single file, 20 tools)
├── package.json              ← pi-package manifest + peer deps
├── tsconfig.json             ← dev-only, for typechecking
├── vps/                      ← Docker deployment (copy this to your VPS)
│   ├── docker-compose.yml    ← memory-core container (port 8420)
│   ├── tdai-gateway.yaml     ← standalone config (SQLite, BM25)
│   └── .env.example          ← template: auth key + LLM creds
└── README.md
```

## Install

**From npm** (once published):

```bash
pi install npm:pi-tencentdb-memory
```

**From git:**

```bash
pi install git:github.com/<you>/pi-tencentdb-memory
```

**Local dev** (clone this repo, then):

```bash
pi install /path/to/pi-tencentdb-memory
```

After install: `/reload` → `/tdmem config` (endpoint = your VPS URL) → `/tdmem status`.

## Architecture

```
┌─ OFFICE / HOME MACHINES ────────────┐        ┌─ VPS ──────────────────┐
│  pi + tencentdb-memory extension    │  HTTP  │  memory-core (Docker)  │
│  (installed via pi install)         │ ─────► │  :8420, SQLite + files │
└─────────────────────────────────────┘        └────────────────────────┘
```

The extension talks to the MemoryCore **v3 HTTP API** (`POST /v3/...`,
Bearer auth, `x-tdai-service-id` header) with zero runtime dependencies.
The gateway is self-hosted — no external API bills beyond the LLM key used
for memory extraction.

## What it gives the LLM

**8 memory tools** (L0–L3):

| Tool | Layer | What it does |
|------|-------|-------------|
| `td_memory_search` | L1 | Recall facts, decisions, preferences |
| `td_memory_add` | L0 | Write conversation turns |
| `td_memory_query` | L0 | Read conversation history |
| `td_memory_core_read` | L3 | Read user persona/profile |
| `td_memory_core_write` | L3 | Overwrite user persona |
| `td_memory_scenario_list` | L2 | List scenario memory files |
| `td_memory_stats` | all | Item counts across layers |
| `td_memory_health` | — | Gateway connectivity check |

**12 knowledge tools** (Skills / Wiki / CodeGraph):

| Tool | What it does |
|------|-------------|
| `td_skill_search/list/create` | Team skill library |
| `td_wiki_create/search/page_read/page_write/ingest/ingest_source` | Wiki knowledge base |
| `td_codegraph_create/sync/search/callers/impact` | Code symbol index |

## VPS setup

```bash
scp -r vps/ user@<VPS_IP>:~/
# on the VPS: cd ~/vps && cp .env.example .env && $EDITOR .env && docker compose up -d
```

Full steps (firewall, TLS, auth, backups) → [vps/README.md](vps/README.md)

## Commands

| Command | What it does |
|---------|-------------|
| `/tdmem config` | System-wide setup (endpoint, API key, isolation ids) |
| `/tdmem config-local` | Per-project overrides (agent/session/user) |
| `/tdmem status` | Show resolved config + health check |
| `/tdmem-sync:chat-memory [all]` | Flush pending turns to L0 |
| `/tdmem-sync:wiki-knowledge [all]` | Archive turns to wiki |
| `/tdmem-sync:code-graph` | Re-sync codegraph index |

## Upstream

The server software being wrapped is
[Tencent/TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory)
(Tencent's team memory hub for AI agents). This repo only contains the pi-side
extension and a minimal Docker deployment for its `memory-core` gateway.

## License

GPL-3.0-only
