ALTER TABLE modify_operations
  DROP INDEX uniq_modify_operations_running_instance,
  DROP COLUMN running_instance_id;
