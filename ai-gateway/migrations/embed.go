package migrations

import "embed"

// Files embeds the SQL migration files for the ai-gateway migration runner.
//
//go:embed *.sql
var Files embed.FS
