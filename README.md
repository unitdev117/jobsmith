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

Shows available work and work already assigned to the current local member. Use ↑/↓ and Enter to select a job, then add notes, set progress, pause, block, complete, fail, release, or save the session.

```bash
jobsmith pending
```

Prints all unfinished project work with its priority, current state, due date, and description.

## States

Jobs may be `PENDING`, `READY`, `IN_PROGRESS`, `PAUSED`, `BLOCKED`, `COMPLETED`, `FAILED`, or `CANCELLED`. Claiming is transactional, so two workers cannot take the same available job. Every mutation is appended to `jobsmith_work_events` and logged without credentials or invitation tokens.

## Development verification

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
```

No build is needed during development. PostgreSQL integration tests only run when `TEST_DATABASE_URL` contains `test` and `TEST_NAMESPACE` is set to a unique value.
