// Package migrations 提供编译进生产二进制的版本化 migration。
package migrations

import "embed"

// FS 只包含正式 SQLite/MySQL/TDSQL runtime migration SQL 和绑定文件。
//
//go:embed sqlite/*.sql sqlite/atlas.sum tdsql/*.sql tdsql/atlas.sum mysql/*.sql mysql/atlas.sum mysql/*.source.sum
var FS embed.FS
