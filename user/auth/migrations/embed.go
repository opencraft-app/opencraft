package migrations

import "embed"

// Files contains the SQL migrations for user-auth.
//
//go:embed *.sql
var Files embed.FS
