-- Persist the per-operation CVM instance-type fallback plan. Existing rows are
-- intentionally left with a NULL plan so the worker resolves it lazily on the
-- next resize_compute retry.

ALTER TABLE modify_operations
  ADD COLUMN source_instance_type VARCHAR(64) NOT NULL DEFAULT '' AFTER completed_at,
  ADD COLUMN instance_type_candidates JSON NULL AFTER source_instance_type,
  ADD COLUMN instance_type_candidate_index INT NOT NULL DEFAULT 0 AFTER instance_type_candidates,
  ADD COLUMN applied_instance_type VARCHAR(64) NOT NULL DEFAULT '' AFTER instance_type_candidate_index;
