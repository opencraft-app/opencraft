ALTER TABLE modify_operations
  DROP COLUMN applied_instance_type,
  DROP COLUMN instance_type_candidate_index,
  DROP COLUMN instance_type_candidates,
  DROP COLUMN source_instance_type;
