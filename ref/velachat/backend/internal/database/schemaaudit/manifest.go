// Package schemaaudit 定义并验证数据库结构的不变量。
package schemaaudit

import "chatserver/internal/database/physicalschema"

// Entry 是物理规格包路由条目的兼容别名。
type Entry = physicalschema.Entry

// Entries 返回 PhysicalSchema manifest 的副本。
func Entries() []Entry { return physicalschema.Manifest() }
