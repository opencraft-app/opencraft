-- Recreate deprecated semantic response cache table for rollback only.

CREATE TABLE IF NOT EXISTS `response_cache` (
  `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `model` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scope_key` varchar(256) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content_hash` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `response` longblob,
  `prompt_tokens` int DEFAULT '0',
  `completion_tokens` int DEFAULT '0',
  `total_tokens` int DEFAULT '0',
  `hit_count` int DEFAULT '0',
  `created_at` datetime(3) DEFAULT NULL,
  `expires_at` datetime(3) DEFAULT NULL,
  `embedding` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_scope_key` (`scope_key`),
  KEY `idx_content_hash` (`content_hash`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
