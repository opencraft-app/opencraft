-- 000001_init_schema.up.sql
-- LightVela Ticket System v1 初始表

CREATE TABLE IF NOT EXISTS ticket (
    id          CHAR(36) NOT NULL,
    user_id     VARCHAR(128) NOT NULL,
    realm       VARCHAR(64) NOT NULL,
    subject     VARCHAR(200) NOT NULL,
    category    VARCHAR(32) NOT NULL,
    status      VARCHAR(32) NOT NULL DEFAULT 'open',
    assignee    VARCHAR(128) NULL,
    created_at  DATETIME(3) NOT NULL,
    updated_at  DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_user_updated (user_id, updated_at),
    KEY idx_realm_status_updated (realm, status, updated_at),
    KEY idx_realm_assignee (realm, assignee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_message (
    id           CHAR(36) NOT NULL,
    ticket_id    CHAR(36) NOT NULL,
    author_type  VARCHAR(16) NOT NULL,
    author_id    VARCHAR(128) NULL,
    body         MEDIUMTEXT NOT NULL,
    created_at   DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ticket_created (ticket_id, created_at),
    CONSTRAINT fk_ticket_message_ticket
        FOREIGN KEY (ticket_id) REFERENCES ticket(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_audit_log (
    id          CHAR(36) NOT NULL,
    ticket_id   CHAR(36) NOT NULL,
    actor_id    VARCHAR(128) NOT NULL,
    action      VARCHAR(64) NOT NULL,
    detail      TEXT NULL,
    created_at  DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ticket_created (ticket_id, created_at),
    CONSTRAINT fk_ticket_audit_ticket
        FOREIGN KEY (ticket_id) REFERENCES ticket(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
