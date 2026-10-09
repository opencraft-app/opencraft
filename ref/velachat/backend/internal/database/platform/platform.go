// Package platform 定义数据库平台适配器的稳定能力契约。
package platform

import (
	"context"
	"database/sql"

	"chatserver/internal/config"
)

// OpenMode 区分会写数据库的主连接与只读诊断连接。
type OpenMode uint8

const (
	OpenModeWriter OpenMode = iota + 1
	OpenModeReadOnly
)

// Handle 是 adapter 向 façade 返回的最小连接契约。
type Handle interface {
	SQLDB() *sql.DB
	Close() error
}

// MigrationStateKind 是平台无关的 migration 状态。
type MigrationStateKind string

const (
	MigrationStateEmpty   MigrationStateKind = "empty"
	MigrationStatePending MigrationStateKind = "pending"
	MigrationStateClean   MigrationStateKind = "clean"
	MigrationStateDirty   MigrationStateKind = "dirty"
	MigrationStateUnsafe  MigrationStateKind = "unsafe"
)

// MigrationState 是 CLI/serve 消费的只读 migration 快照。
type MigrationState struct {
	Kind              MigrationStateKind
	Reason            string
	CurrentVersion    string
	LatestVersion     string
	Applied           int
	Pending           int
	AppliedStatements int
	TotalStatements   int
}

// Capabilities 描述基础设施层真正消费的数据库能力。
type Capabilities struct {
	PhysicalSharding   bool
	TransactionalDDL   bool
	RequiresProxyAudit bool
}

// Adapter 标识一种正式支持的数据库平台。
type Adapter interface {
	Driver() config.DatabaseDriver
	Open(context.Context, config.Database, OpenMode) (Handle, error)
	Migrate(context.Context, *sql.DB) error
	MigrationStatus(context.Context, *sql.DB) (MigrationState, error)
	VerifySchema(context.Context, *sql.DB) error
	Capabilities() Capabilities
}
