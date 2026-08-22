-- Covers ManualJobService.listPending(): the query filters every non-terminal
-- status and orders by priority/recency, which the PENDING/READY-only partial
-- index could not serve.
CREATE INDEX IF NOT EXISTS jobsmith_work_active_idx
  ON jobsmith_work_items (project_id, priority DESC, created_at)
  WHERE status IN ('PENDING','READY','IN_PROGRESS','PAUSED','BLOCKED');
