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

	"git.woa.com/wisp/mono2/collaboration/internal/apperror"
	"git.woa.com/wisp/mono2/collaboration/internal/config"
	"git.woa.com/wisp/mono2/collaboration/internal/database"
	"git.woa.com/wisp/mono2/collaboration/internal/database/migration"
	"git.woa.com/wisp/mono2/collaboration/internal/database/platform"
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
	if len(args) > 1 && args[0] == "im" && args[1] == "restrict" {
		return runIMRestrictCommand(ctx, args[2:], stdout, stderr)
	}
	if len(args) > 1 && args[0] == "im" && args[1] == "accounts" {
		return runIMAccountsCommand(ctx, args[2:], stdout, stderr)
	}
	if len(args) < 2 || args[0] != "database" {
		writeUsage(stderr)
		return 2
	}
	action := args[1]
	if action == "check-consistency" {
		return runConsistencyCommand(ctx, args[2:], stdout, stderr)
	}
	if action == "recover-empty-baseline" {
		cfg, apply, err := parseDatabaseRecoveryConfig(args[2:])
		if err == nil {
			err = recoverEmptyBaselineDatabase(ctx, cfg, apply, stdout)
		}
		if err != nil {
			writeCommandError(stderr, err)
			return exitCode(err)
		}
		return 0
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

func parseDatabaseRecoveryConfig(args []string) (config.Database, bool, error) {
	filtered := make([]string, 0, len(args))
	apply := false
	for _, arg := range args {
		if arg != "--apply" {
			filtered = append(filtered, arg)
			continue
		}
		if apply {
			return config.Database{}, false, apperror.New(
				"CONFIG_INVALID", "数据库恢复命令参数无效", nil,
			)
		}
		apply = true
	}
	cfg, err := parseDatabaseConfig("recover-empty-baseline", filtered)
	if err != nil {
		return config.Database{}, false, err
	}
	if cfg.Driver != config.DatabaseDriverMySQL {
		return config.Database{}, false, apperror.New(
			"CONFIG_INVALID", "空基线恢复只允许显式 MySQL 方言", nil,
		)
	}
	return cfg, apply, nil
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
	flags.StringVar(&driver, "database-driver", driver, "数据库方言：sqlite、mysql 或 tdsql")
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
	case config.DatabaseDriverMySQL:
		cfg, err = config.NewMySQLDatabase(dsnFile)
	}
	if cfg.Driver == config.DatabaseDriverTDSQL || cfg.Driver == config.DatabaseDriverMySQL {
		if err == nil {
			cfg.MaxOpenConnections = maxOpenConnections
			cfg.MaxIdleConnections = maxIdleConnections
			cfg.ConnectionMaxLifetime = connectionMaxLifetime
		}
	} else if cfg.Driver == "" && err == nil {
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

func recoverEmptyBaselineDatabase(
	ctx context.Context,
	cfg config.Database,
	apply bool,
	stdout io.Writer,
) (returnErr error) {
	var (
		handle *database.Handle
		err    error
	)
	if apply {
		handle, err = database.OpenWriter(ctx, cfg)
	} else {
		handle, err = database.OpenReadOnly(ctx, cfg)
	}
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := handle.Close(); returnErr == nil && closeErr != nil {
			returnErr = apperror.New("DATABASE_OPEN_FAILED", "关闭数据库连接失败", closeErr)
		}
	}()
	result, err := migration.RecoverEmptyMySQLBaseline(ctx, handle.SQLDB(), apply)
	if err != nil {
		return err
	}
	if result.AlreadyEmpty && !result.Applied {
		fmt.Fprintf(stdout, "数据库：%s\n恢复状态：无需操作，数据库已为空\n", maskedDatabaseTarget(cfg))
		return nil
	}
	if !apply {
		fmt.Fprintf(
			stdout,
			"数据库：%s\n恢复计划：可执行\n残留业务表：1\n残留业务行：%d\n",
			maskedDatabaseTarget(cfg),
			result.TableRows,
		)
		return nil
	}
	fmt.Fprintf(
		stdout,
		"数据库：%s\n恢复完成\n迁移状态：尚未迁移\n",
		maskedDatabaseTarget(cfg),
	)
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
	if cfg.Driver == config.DatabaseDriverTDSQL || cfg.Driver == config.DatabaseDriverMySQL {
		return strings.ToUpper(string(cfg.Driver)) + "（DSN Secret）"
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
	fmt.Fprintln(output, "  chatserver database <migrate|status|verify> [--database-driver sqlite|mysql|tdsql]")
	fmt.Fprintln(output, "  chatserver database recover-empty-baseline --database-driver mysql --database-dsn-file 文件 [--apply]")
	fmt.Fprintln(output, "  chatserver database check-consistency --scope server|account|registry --partition-key KEY [--registry-type TYPE]")
	fmt.Fprintln(output, "  chatserver im restrict --im-user-id ID [--release] --im-sdk-app-id ID --im-admin-user-id UserID --im-secret-key-file 文件")
	fmt.Fprintln(output, "  chatserver im accounts [--list] [--check --im-sdk-app-id ID --im-admin-user-id UserID --im-secret-key-file 文件]")
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
