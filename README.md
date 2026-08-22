# Jobsmith

Jobsmith is a CLI-only work coordinator for people and AI agents. A manager enlists work, a worker claims and updates it, and every member sees the same project state from any machine. PostgreSQL is the source of truth; Valkey publishes lightweight project-change notifications.

There is no webpage, HTTP API, dashboard, or automatic job executor.

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

Valkey is **never required for correctness**. Only the **host device** runs a Valkey server (for example, under the project domain); member devices connect to the host's `valkeyUrl` from their `.jobsmith/config.json`. If Valkey is missing or down, every command still works — only the realtime niceties below are lost, and `jobsmith status` reports `online workers: unavailable` instead of failing.

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

Prints all unfinished project work with its priority, current state, due date, and description.

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

## States

Jobs may be `PENDING`, `READY`, `IN_PROGRESS`, `PAUSED`, `BLOCKED`, `COMPLETED`, `FAILED`, or `CANCELLED`. Claiming is transactional, so two workers cannot take the same available job; multi-select claims run in one transaction and report per-job failures. Every mutation is appended to `jobsmith_work_events` and logged without credentials or invitation tokens.

## Development verification

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
```

No build is needed during development. PostgreSQL integration tests only run when `TEST_DATABASE_URL` contains `test` and `TEST_NAMESPACE` is set to a unique value; the Valkey realtime integration test runs when `TEST_VALKEY_URL` points at a live Valkey.

Migration files are numbered from `0002` because the original baseline was consolidated into one file before the first release; applied migrations are recorded by filename, so never rename them.

For faster cold starts on Neon free tier, use the `-pooler` (PgBouncer) endpoint in your connection string.
