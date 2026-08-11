# Jobsmith

Jobsmith is a terminal-native human job queue. Managers create work through a guided wizard; workers choose jobs with the arrow keys and update them inside a resumable terminal session. PostgreSQL stores jobs, ownership, progress, and audit history.

There is no web server, HTTP API, dashboard, Valkey service, or automated handler runtime.

## Setup

```bash
cp .env.example .env
chmod 600 .env
bun install --frozen-lockfile
bun run migrate
bun link
```

The only required setting is a PostgreSQL connection string:

```dotenv
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
DATABASE_MIGRATION_URL=
LOG_LEVEL=warn
```

`DATABASE_MIGRATION_URL` is optional. When blank, migrations use `DATABASE_URL`.

## Commands

### Manager

```bash
jobsmith manager
```

The wizard asks for the job name, description, priority, optional due date, optional tags, and final confirmation. Name, description, and priority are required.

### Worker

```bash
jobsmith worker
```

Enter your name, select an available job with ↑/↓ and Enter, then choose an action:

- add a progress note;
- update completion percentage;
- mark the job completed;
- mark the job failed with a reason;
- release it for another worker;
- save and exit, leaving it assigned for later resumption.

PostgreSQL conditional updates ensure only one worker can claim a pending job. A worker can resume their own in-progress jobs by running the command again with the same name.

### Pending jobs

```bash
jobsmith pending
```

This prints a compact table with job ID, name, priority, due date, and description.

If `jobsmith` is not linked globally, use:

```bash
bun run manager
bun run worker
bun run pending
```

## States

```text
PENDING → IN_PROGRESS → COMPLETED
                      → FAILED
          ↓
        PENDING (released)
```

Every creation, claim, note, progress update, saved session, release, completion, and failure is appended to `work_events`.

## Verification

```bash
bun run format:check
bun run typecheck
bun run lint
bun test
```

PostgreSQL integration tests require an isolated `TEST_DATABASE_URL` containing `test` in its name and a unique `TEST_NAMESPACE`.
