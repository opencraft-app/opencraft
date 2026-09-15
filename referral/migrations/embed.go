package migrations

import "embed"

// Files contains the referral schema migrations.
//
//go:embed *.sql
var Files embed.FS
