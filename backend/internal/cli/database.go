// Package cli 提供 Chatserver 的轻量命令行入口。
package cli

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"chatserver/internal/apperror"
	"chatserver/internal/config"
	"chatserver/internal/database"
	"chatserver/internal/database/platform"
)

const (
	databasePathEnvironment    = "CHATSERVER_DATABASE_PATH"
	databaseDriverEnvironment  = "CHATSERVER_DATABASE_DRIVER"
	databaseDSNFileEnvironment = "CHATSERVER_DATABASE_DSN_FILE"
)

// Run 执行命令并返回适合进程退出的状态码。
func Run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "serve" {
		return runServeCommand(ctx, args[1:], stdout, stderr)
	}
	if len(args) < 2 || args[0] != "database" {
		writeUsage(stderr)
		return 2
	}
	action := args[1]
	if action == "check-consistency" {
		return runConsistencyCommand(ctx, args[2:], stdout, stderr)
	}
	if action != "migrate" && action != "status" && action != "verify" {
		writeUsage(stderr)
		return 2
	}

	cfg, err := parseDatabaseConfig(action, args[2:])
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}

	switch action {
	case "migrate":
		err = migrateDatabase(ctx, cfg, stdout)
	case "status":
		err = statusDatabase(ctx, cfg, stdout)
	case "verify":
		err = verifyDatabase(ctx, cfg, stdout)
	}
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	return 0
}

func parseDatabaseConfig(action string, args []string) (config.Database, error) {
	path, err := defaultDatabasePath()
	if err != nil {
		return config.Database{}, err
	}
	driver := os.Getenv(databaseDriverEnvironment)
	if driver == "" {
		driver = string(config.DatabaseDriverSQLite)
	}
	dsnFile := os.Getenv(databaseDSNFileEnvironment)
	var busyTimeout, lockTimeout, connectionMaxLifetime time.Duration
	var maxOpenConnections, maxIdleConnections int
	flags := flag.NewFlagSet("database "+action, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&driver, "database-driver", driver, "数据库方言：sqlite 或 tdsql")
	flags.StringVar(&path, "database", path, "SQLite 数据库绝对路径")
	flags.StringVar(&dsnFile, "database-dsn-file", dsnFile, "TDSQL DSN Secret 文件")
	flags.DurationVar(&busyTimeout, "busy-timeout", 5*time.Second, "SQLite 忙等待时间")
	flags.DurationVar(&lockTimeout, "lock-timeout", 5*time.Second, "Writer 锁等待时间")
	flags.IntVar(&maxOpenConnections, "database-max-open-connections", 20, "MySQL 最大连接数")
	flags.IntVar(&maxIdleConnections, "database-max-idle-connections", 20, "MySQL 最大空闲连接数")
	flags.DurationVar(&connectionMaxLifetime, "database-connection-max-lifetime", 3*time.Minute, "MySQL 连接最长生命周期")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return config.Database{}, apperror.New("CONFIG_INVALID", "数据库命令参数无效", err)
	}
	var cfg config.Database
	switch config.DatabaseDriver(strings.ToLower(strings.TrimSpace(driver))) {
	case config.DatabaseDriverSQLite:
		cfg, err = config.NewDatabase(path)
		if err == nil {
			cfg.BusyTimeout = busyTimeout
			cfg.LockTimeout = lockTimeout
		}
	case config.DatabaseDriverTDSQL:
		cfg, err = config.NewTDSQLDatabase(dsnFile)
		if err == nil {
			cfg.MaxOpenConnections = maxOpenConnections
			cfg.MaxIdleConnections = maxIdleConnections
			cfg.ConnectionMaxLifetime = connectionMaxLifetime
		}
	default:
		return config.Database{}, apperror.New("CONFIG_INVALID", "数据库方言不受支持", nil)
	}
	if err != nil {
		return config.Database{}, err
	}
	if err := cfg.Validate(); err != nil {
		return config.Database{}, err
	}
	return cfg, nil
}

func defaultDatabasePath() (string, error) {
	if value := os.Getenv(databasePathEnvironment); value != "" {
		return value, nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", apperror.New("CONFIG_INVALID", "无法确定默认数据库目录", err)
	}
	return filepath.Join(root, "chatserver", "chatserver.db"), nil
}

func migrateDatabase(ctx context.Context, cfg config.Database, stdout io.Writer) (returnErr error) {
	adapter, err := database.AdapterFor(cfg.Driver)
	if err != nil {
		return err
	}
	handle, err := database.OpenWriter(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := handle.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("DATABASE_OPEN_FAILED", "关闭数据库连接失败", closeErr)
		}
	}()

	if err := adapter.Migrate(ctx, handle.SQLDB()); err != nil {
		return err
	}
	info, err := adapter.MigrationStatus(ctx, handle.SQLDB())
	if err != nil {
		return err
	}
	if err := migrationStateError(info); err != nil {
		return err
	}
	if err := adapter.VerifySchema(ctx, handle.SQLDB()); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "数据库：%s\n迁移完成\n当前版本：%s\n待执行：0\n",
		maskedDatabaseTarget(cfg), displayVersion(info.CurrentVersion))
	return nil
}

func statusDatabase(ctx context.Context, cfg config.Database, stdout io.Writer) (returnErr error) {
	adapter, err := database.AdapterFor(cfg.Driver)
	if err != nil {
		return err
	}
	handle, err := database.OpenReadOnly(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := handle.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("DATABASE_OPEN_FAILED", "关闭数据库连接失败", closeErr)
		}
	}()

	info, err := adapter.MigrationStatus(ctx, handle.SQLDB())
	if err != nil {
		return err
	}
	state := "正常"
	switch info.Kind {
	case platform.MigrationStateEmpty:
		state = "尚未迁移"
	case platform.MigrationStatePending:
		state = "迁移中断"
	case platform.MigrationStateDirty:
		state = "迁移失败"
	case platform.MigrationStateUnsafe:
		state = "状态不安全"
	}
	fmt.Fprintf(stdout,
		"数据库：%s\n当前版本：%s\n最新版本：%s\n已应用：%d\n待执行：%d\n校验和：正常\n迁移状态：%s\n",
		maskedDatabaseTarget(cfg),
		displayVersion(info.CurrentVersion),
		displayVersion(info.LatestVersion),
		info.Applied,
		info.Pending,
		state,
	)
	return nil
}

func verifyDatabase(ctx context.Context, cfg config.Database, stdout io.Writer) (returnErr error) {
	adapter, err := database.AdapterFor(cfg.Driver)
	if err != nil {
		return err
	}
	handle, err := database.OpenReadOnly(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := handle.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("DATABASE_OPEN_FAILED", "关闭数据库连接失败", closeErr)
		}
	}()

	info, err := adapter.MigrationStatus(ctx, handle.SQLDB())
	if err != nil {
		return err
	}
	if err := migrationStateError(info); err != nil {
		return err
	}
	if err := adapter.VerifySchema(ctx, handle.SQLDB()); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "数据库：%s\n校验通过\n版本：%s\n",
		maskedDatabaseTarget(cfg), displayVersion(info.CurrentVersion))
	return nil
}

func migrationStateError(state platform.MigrationState) error {
	switch state.Kind {
	case platform.MigrationStateClean:
		return nil
	case platform.MigrationStateEmpty:
		return apperror.New(
			"DATABASE_MIGRATION_REQUIRED",
			"数据库尚未初始化",
			nil,
		)
	case platform.MigrationStateUnsafe:
		if state.Reason == "not_empty" {
			return apperror.New(
				"DATABASE_NOT_EMPTY",
				"数据库不是可安全初始化的空库",
				nil,
			)
		}
		fallthrough
	case platform.MigrationStatePending, platform.MigrationStateDirty:
		return apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库迁移状态不安全，需要重建全新数据库",
			nil,
		)
	default:
		return apperror.New(
			"DATABASE_MIGRATION_UNSAFE",
			"数据库迁移状态无法识别",
			nil,
		)
	}
}

func maskedDatabasePath(path string) string {
	return "…/" + filepath.Base(path)
}

func maskedDatabaseTarget(cfg config.Database) string {
	if cfg.Driver == config.DatabaseDriverTDSQL {
		return "TDSQL（DSN Secret）"
	}
	return maskedDatabasePath(cfg.Path)
}

func displayVersion(version string) string {
	if version == "" {
		return "无"
	}
	return version
}

func writeUsage(output io.Writer) {
	fmt.Fprintln(output, "用法：")
	fmt.Fprintln(output, "  chatserver database <migrate|status|verify> [--database-driver sqlite|tdsql]")
	fmt.Fprintln(output, "  chatserver database check-consistency --scope server|account|registry --partition-key KEY [--registry-type TYPE]")
	fmt.Fprintln(
		output,
		"  chatserver serve --jwt-key-file 文件 --im-sdk-app-id ID "+
			"--im-admin-user-id UserID --im-secret-key-file 文件 "+
			"--im-identity-key-file 文件 [--database 绝对路径] [--listen 地址]",
	)
}

func writeCommandError(output io.Writer, err error) {
	code := apperror.CodeOf(err)
	if code == "" {
		code = "INTERNAL_ERROR"
		fmt.Fprintf(output, "错误 [%s]：命令执行失败\n", code)
		return
	}
	fmt.Fprintf(output, "错误 [%s]：%s\n", code, err.Error())
}

func exitCode(err error) int {
	switch apperror.CodeOf(err) {
	case "CONFIG_INVALID":
		return 2
	case "DATABASE_IN_USE":
		return 3
	default:
		return 1
	}
}
