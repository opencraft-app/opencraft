
CREATE INDEX token_usage_gaps_open_thread ON token_usage_gaps(server_id,thread_id) WHERE ends_ms IS NULL;

DELETE FROM token_usage_gaps WHERE ends_ms IS NOT NULL;
