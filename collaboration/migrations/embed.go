// Package migrations 提供编译进生产二进制的版本化 migration。
package migrations

import "embed"

// FS 只包含正式 SQLite/TDSQL runtime migration SQL 和 atlas.sum。
//
//go:embed sqlite/*.sql sqlite/atlas.sum tdsql/*.sql tdsql/atlas.sum
var FS embed.FS
