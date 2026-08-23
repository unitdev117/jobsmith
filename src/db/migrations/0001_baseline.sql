-- Baseline schema, consolidated before the first release. There is no
-- upgrade history to preserve: development databases are recreated from
-- this file. Once real deployments exist, new migrations must never be
-- edited and schema_migrations records applied files by name.
CREATE TABLE IF NOT EXISTS jobsmith_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS jobsmith_members (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES jobsmith_projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  role text NOT NULL CHECK (role IN ('HOST','MEMBER','AGENT')),
  machine_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, machine_id)
);

CREATE TABLE IF NOT EXISTS jobsmith_invites (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES jobsmith_projects(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES jobsmith_members(id),
  consumed_by uuid REFERENCES jobsmith_members(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS jobsmith_invites_active_idx
  ON jobsmith_invites (project_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS jobsmith_work_items (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES jobsmith_projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 9),
  status text NOT NULL CHECK (status IN (
    'PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED','COMPLETED','FAILED','CANCELLED'
  )),
  progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  assigned_member_id uuid REFERENCES jobsmith_members(id),
  assigned_worker_name text CHECK (char_length(assigned_worker_name) <= 120),
  tags text[] NOT NULL DEFAULT '{}',
  due_at timestamptz,
  failure_reason text CHECK (char_length(failure_reason) <= 4000),
  blocked_reason text CHECK (char_length(blocked_reason) <= 4000),
  -- Claim leases: refreshed whenever the owner touches the job; expired
  -- leases may be taken over by another worker.
  claimed_until timestamptz,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobsmith_work_available_idx
  ON jobsmith_work_items (project_id, priority DESC, created_at)
  WHERE status IN ('PENDING','READY');

CREATE INDEX IF NOT EXISTS jobsmith_work_active_idx
  ON jobsmith_work_items (project_id, priority DESC, created_at)
  WHERE status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED');

CREATE INDEX IF NOT EXISTS jobsmith_work_member_idx
  ON jobsmith_work_items (project_id, assigned_member_id, updated_at DESC)
  WHERE status IN ('IN_PROGRESS','PAUSED','BLOCKED');

CREATE TABLE IF NOT EXISTS jobsmith_work_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES jobsmith_projects(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES jobsmith_work_items(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  member_id uuid REFERENCES jobsmith_members(id),
  worker_name text,
  note text CHECK (char_length(note) <= 4000),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS jobsmith_work_events_item_idx
  ON jobsmith_work_events (project_id, work_item_id, created_at, id);
