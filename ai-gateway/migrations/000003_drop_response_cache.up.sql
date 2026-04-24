-- Remove deprecated semantic response cache storage and config.

DELETE FROM runtime_configs
WHERE `key` IN (
  'cache.enabled',
  'cache.ttl_seconds',
  'cache.similarity_threshold',
  'cache.max_response_bytes',
  'cache.scope_mode',
  'cache.max_cache_entries',
  'cache.embedding_model',
  'cache.embedding_base_url',
  'cache.embedding_api_key'
);

DROP TABLE IF EXISTS response_cache;
