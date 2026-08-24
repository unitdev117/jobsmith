# Jobsmith

Jobsmith is a terminal-native work coordinator for people and AI agents. A manager enlists work, a worker claims and updates it, and every member sees the same project state from any machine. PostgreSQL is the source of truth; Valkey publishes lightweight project-change notifications. A local web dashboard (optional) renders the same project state in the browser.

## Commands

| Command                               | What it does                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `jobsmith init`                       | Initialize this folder as a project host, or join an existing project with a connection string     |
| `jobsmith connect`                    | Generate a one-use connection string so another person or agent can join (host only)               |
| `jobsmith remove`                     | Remove Jobsmith initialization from this folder only                                               |
| `jobsmith manager`                    | Enlist a new job through an interactive wizard                                                     |
| `jobsmith worker`                     | Select and claim one or more available jobs                                                        |
| `jobsmith update`                     | Report progress on claimed work: add notes, set progress, pause, block, complete, fail, or release |
| `jobsmith pending`                    | Show unfinished jobs with stable keyset pagination (`--limit N`, follow the printed `--cursor`)    |
| `jobsmith daemon start\|stop\|status` | Manage the background worker that keeps the local cache fresh and heartbeats presence              |
| `jobsmith status`                     | Show which members currently have an online daemon                                                 |
| `jobsmith server start\|stop\|status` | Manage the local REST API + web dashboard on `127.0.0.1`                                           |
| `jobsmith help`                       | Show command help                                                                                  |

## Install

```bash
bun install --frozen-lockfile
bun link
```

The machine that initializes a project needs a `.env` file:

```dotenv
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
DATABASE_MIGRATION_URL=
VALKEY_URL=redis://127.0.0.1:6379
INVITE_TTL_MINUTES=5
LOG_LEVEL=warn
```

When using the globally linked development command, Jobsmith also checks the installation repository's `.env`. If either required connection is still missing, `jobsmith init` asks for it; PostgreSQL input is hidden in an interactive terminal.

`DATABASE_MIGRATION_URL` is optional. For collaboration across machines, both `DATABASE_URL` and `VALKEY_URL` must be reachable from every machine; `127.0.0.1` only works when all clients run on the same machine.

## Valkey (host-owned, optional)

Valkey is **never required for correctness**. Only the **host device** runs a Valkey server (for example, under the project domain); member devices connect to the host's `valkeyUrl` from their `.jobsmith/config.json`. If Valkey is missing or down, every command still works — only the realtime niceties below are lost, and `jobsmith status` reports `online workers: unavailable` instead of failing. Dashboard listings additionally self-refresh when their snapshot is more than ~15 seconds old, so external writes stay visible without events.

## Initialize or join

From the project folder, run:

```bash
jobsmith init
```

Choose with the arrow keys:

- **Initialize** creates the shared project and makes you its host. It applies migrations and immediately prints the first connection string.
- **Join** asks for a host-generated connection string, your name, and whether you are a person or AI agent.

Initialization writes `.jobsmith/config.json` with mode `0600`. It contains the project identity and service connections, is ignored by Git, and is discovered from nested folders.

A host can generate another connection string with:

```bash
jobsmith connect
```

Each connection string is accepted by Jobsmith once and expires after `INVITE_TTL_MINUTES` (default: five minutes). It is a bearer secret containing the shared service connections, so send it only through a secure channel. Expiry prevents Jobsmith redemption; it cannot revoke a database password that someone copied from the string. Rotate shared service credentials if a connection string is exposed.

To remove Jobsmith from only the current folder:

```bash
jobsmith remove
```

Removal requires typing the full word `yes`. It deletes only the local `.jobsmith` configuration, not shared project data or other members. The same folder can run `jobsmith init` again afterward.

## Work commands

```bash
jobsmith manager
```

Prompts for the required name, description, and priority, then optional due date and tags.

Descriptions may be plain text. Wrapping the whole description in `{ ... }` renders it as Markdown on the dashboard (headings, lists, tables, task lists, fenced code, links); unmatched braces display as-is. Raw HTML always displays as text, links are limited to `http`/`https`/`mailto`, and embedded images are not rendered.

The manager's Description prompt is line-based: type `\n` where a line break is wanted, `\\n` for a literal backslash-n. This applies only to that prompt; the web textarea accepts real Enter keys.

```bash
jobsmith worker
```

Shows available work and work already assigned to the current local member. Use ↑/↓, Space, and Enter to claim one or more jobs, then returns the terminal.

```bash
jobsmith update
jobsmith update "Job name"
```

Reports notes, progress, pauses, blockers, completion, failure, or release for claimed work. A name can be an exact title, unique prefix, or substring. If no claimed job matches the name, Jobsmith offers to cancel an unclaimed job with that title instead.

The update menu also lets a worker cancel their own claimed job permanently. Unclaimed pending jobs can be cancelled by any member through the same name lookup.

```bash
jobsmith pending
```

Prints all unfinished project work with its priority, current state, due date, and description. Listing is keyset-paginated for stable scrolling under concurrent edits: pass `--limit N` to size pages and follow the printed `--cursor` hint for the next page.

## Online workers

```bash
jobsmith daemon start
jobsmith daemon status
jobsmith daemon stop
```

`jobsmith daemon` runs a background process on a device (any device, including an always-on agent host). On startup it refreshes the local job cache once, then subscribes to the host's Valkey and refreshes the cache again on every project event, so reads stay current instead of waiting for the 90-second snapshot TTL. It also heartbeats presence every 30 seconds (60-second TTL) so other members can see the device online. The daemon holds only the long-lived Valkey connection; it connects to Neon per event and closes it after, never continuously.

```bash
jobsmith status
```

Lists which workers/devices are currently online from Valkey presence keys. Without a running daemon, reads still fall back to the 90-second cache, and `jobsmith status` degrades gracefully when Valkey is unreachable.

## Local API and dashboard

```bash
jobsmith server start
jobsmith server status
jobsmith server stop
```

`server start` launches a detached background process (like `daemon start`), prints the dashboard URL, and returns your terminal immediately. Logs land in `.jobsmith/server.log`. The process serves a read/write REST API and a small web dashboard bound to `127.0.0.1` on the machine that runs it — nothing is hosted anywhere; each member serves their own view of the project from their own folder. The dashboard is plain HTML/JS with no build step and consumes the same API the CLI uses. Mutations made through it go through the same service layer as CLI commands, so ownership rules, transactional claims, event notifications, and daemon cache refreshes all behave identically.

The server binds its port immediately and keeps its work list in memory, reloading whenever a project event arrives over Valkey (bursts coalesce into one database load). Until the first load succeeds — for example while a suspended database wakes — job reads answer `503` and retry automatically in the background, so the dashboard never shows an empty list that only looks complete. Browsers subscribe via `GET /api/events` and refetch when the store changes; a manual refresh button is also available in the header.

Endpoints (all JSON under `/api`): project identity, paged job listing (`state` filter), exact per-state totals via `?state=X&count=true`, job create/edit/cancel/claim, worker transitions (`transition`, `progress`, `notes`), host-only invite creation, member list with live presence, `GET /api/events` (Server-Sent Events: one `ready` frame, then a `change` frame per published project event; clients refetch views rather than trusting payloads; answers `503 events_unavailable` while the event host is unreachable), `/healthz`, and `/metrics` in Prometheus text format.

Environment variables:

| Variable               | Default | Purpose                                                                                                                                        |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `JOBSMITH_PORT`        | `7050`  | Listen port (`--port` flag overrides; set it in your `.env`)                                                                                   |
| `JOBSMITH_SERVE_TOKEN` | unset   | When set, `/api/*` requires `Authorization: Bearer <token>`                                                                                    |
| `JOBSMITH_RATE_LIMIT`  | `120`   | Requests per minute per client IP; over the limit returns 429 with `Retry-After`. The limiter lives in Valkey and fails open if Valkey is down |

## States

Jobs may be `PENDING`, `READY`, `IN_PROGRESS`, `PAUSED`, `BLOCKED`, `COMPLETED`, `FAILED`, or `CANCELLED`. Claiming is transactional, so two workers cannot take the same available job; multi-select claims run in one transaction and report per-job failures. Other members' claimed jobs never appear in `jobsmith worker`; they stay visible in `jobsmith pending`.

Claims are leases: every owner action refreshes a 30-minute lease, and an expired lease releases the job back to the pool automatically, so a closed terminal or crashed agent session never strands work. Every mutation is appended to `jobsmith_work_events` and logged without credentials or invitation tokens.

## Development verification

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
```

No build is needed during development. PostgreSQL integration tests only run when `TEST_DATABASE_URL` contains `test` and `TEST_NAMESPACE` is set to a unique value; the Valkey realtime integration test runs when `TEST_VALKEY_URL` points at a live Valkey.

Migration files are numbered from a single `0001_baseline.sql` that was consolidated before the first release; applied migrations are recorded by filename, so never rename them and never edit an already-released migration.

For faster cold starts on Neon free tier, use the `-pooler` (PgBouncer) endpoint in your connection string.
