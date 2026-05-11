package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

// MySQLStore 是 trade 服务的 MySQL 数据访问层入口。
//
// 当前迭代仅承载连接池生命周期；trade_order / trade_flow / trade_bundle_definition
// 三张表的 DAO 方法（CreateOrder / GetOrderByDealName / TryAcquireFlow / CompleteFlow / FailFlow /
// ListInProgressFlowsBefore / GetBundleDefinitionByID 等）将在迭代 5 / 6 / 7 按 §6.2 / §7.3 落地补全。
type MySQLStore struct {
	db *sql.DB
}

// NewMySQLStore 构造连接池并执行 ping 验活。
//
// 迁移参数：UTC 时间 + parseTime=true + time_zone='+00:00'，与 payment / subscription 同步。
func NewMySQLStore(dsn string) (*MySQLStore, error) {
	cfg, err := mysql.ParseDSN(strings.TrimSpace(dsn))
	if err != nil {
		return nil, fmt.Errorf("parse mysql dsn: %w", err)
	}
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	if cfg.Params == nil {
		cfg.Params = make(map[string]string)
	}
	cfg.Params["time_zone"] = "'+00:00'"
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, fmt.Errorf("open mysql: %w", err)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mysql: %w", err)
	}
	return &MySQLStore{db: db}, nil
}

// DB 暴露底层 *sql.DB，主要给迭代 5 / 6 / 7 实现具体 DAO 时直接拿连接执行 SQL。
func (s *MySQLStore) DB() *sql.DB {
	if s == nil {
		return nil
	}
	return s.db
}

// Close 关闭底层连接池。
func (s *MySQLStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}
