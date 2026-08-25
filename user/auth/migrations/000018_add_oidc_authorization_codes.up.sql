CREATE TABLE IF NOT EXISTS oidc_authorization_codes (
    code_hash BINARY(32) NOT NULL,
    client_id VARCHAR(128) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    redirect_uri VARCHAR(512) NOT NULL,
    scope VARCHAR(255) NOT NULL,
    code_challenge VARCHAR(255) NOT NULL,
    nonce VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME NULL,
    created_at DATETIME NOT NULL,
    PRIMARY KEY (code_hash),
    KEY idx_oidc_authorization_codes_user_id (user_id),
    KEY idx_oidc_authorization_codes_expires_at (expires_at)
);
