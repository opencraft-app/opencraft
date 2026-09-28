-- 000002_support_feedback_mysql.up.sql
-- Store support feedback records and attachments in the ticket MySQL database.

CREATE TABLE IF NOT EXISTS support_feedback (
    id            VARCHAR(32)  NOT NULL,
    account_id    VARCHAR(128) NOT NULL,
    site          VARCHAR(16)  NOT NULL,
    category      VARCHAR(32)  NOT NULL,
    feedback_type VARCHAR(64)  NOT NULL,
    other_text    VARCHAR(255) NULL,
    subject       VARCHAR(200) NOT NULL,
    description   MEDIUMTEXT   NOT NULL,
    contact_info  VARCHAR(255) NULL,
    profile_json  JSON         NULL,
    bug_info_json JSON         NULL,
    status        VARCHAR(32)  NOT NULL DEFAULT 'open',
    source        VARCHAR(32)  NOT NULL DEFAULT 'support-page',
    created_at    DATETIME(3)  NOT NULL,
    updated_at    DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_support_feedback_site_created (site, created_at),
    KEY idx_support_feedback_account_created (account_id, created_at),
    KEY idx_support_feedback_status_updated (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_feedback_attachment (
    id          VARCHAR(40)  NOT NULL,
    feedback_id VARCHAR(32)  NOT NULL,
    file_name   VARCHAR(255) NOT NULL,
    content_type VARCHAR(128) NOT NULL,
    size_bytes  BIGINT       NOT NULL,
    content     LONGBLOB     NOT NULL,
    created_at  DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_support_feedback_attachment_feedback (feedback_id, created_at),
    CONSTRAINT fk_support_feedback_attachment_feedback
        FOREIGN KEY (feedback_id) REFERENCES support_feedback(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
