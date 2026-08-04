package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"chatserver/internal/apperror"
	"chatserver/internal/database"
	"chatserver/internal/database/consistency"
)

func runConsistencyCommand(
	ctx context.Context,
	args []string,
	stdout, stderr io.Writer,
) int {
	options, databaseArgs, err := parseConsistencyOptions(args)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	cfg, err := parseDatabaseConfig("check-consistency", databaseArgs)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	handle, err := database.OpenReadOnly(ctx, cfg)
	if err != nil {
		writeCommandError(stderr, err)
		return exitCode(err)
	}
	defer handle.Close()
	scanner, err := consistency.New(handle.SQLDB())
	if err != nil {
		writeCommandError(stderr, err)
		return 1
	}
	report, err := scanner.Scan(ctx, options)
	if err != nil {
		writeCommandError(stderr, apperror.New("DATABASE_CONSISTENCY_CHECK_FAILED", "数据库一致性扫描失败", err))
		return 1
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(report); err != nil {
		writeCommandError(stderr, apperror.New("INTERNAL_ERROR", "无法输出一致性扫描结果", err))
		return 1
	}
	if len(report.Issues) > 0 {
		fmt.Fprintf(stderr, "错误 [DATABASE_CONSISTENCY_VIOLATION]：发现 %d 条一致性问题\n", len(report.Issues))
		return 1
	}
	return 0
}

func parseConsistencyOptions(args []string) (consistency.Options, []string, error) {
	options := consistency.Options{Limit: 1000}
	databaseArgs := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		name, value, hasValue := strings.Cut(args[index], "=")
		switch name {
		case "--scope", "--partition-key", "--registry-type", "--cursor", "--limit":
			if !hasValue {
				index++
				if index >= len(args) {
					return consistency.Options{}, nil, apperror.New("CONFIG_INVALID", name+" 缺少值", nil)
				}
				value = args[index]
			}
			switch name {
			case "--scope":
				options.Scope = consistency.Scope(value)
			case "--partition-key":
				options.PartitionKey = value
			case "--registry-type":
				options.RegistryType = value
			case "--cursor":
				options.Cursor = value
			case "--limit":
				parsed, err := strconv.Atoi(value)
				if err != nil {
					return consistency.Options{}, nil, apperror.New("CONFIG_INVALID", "--limit 无效", err)
				}
				options.Limit = parsed
			}
		default:
			databaseArgs = append(databaseArgs, args[index])
		}
	}
	if options.Scope == "" || strings.TrimSpace(options.PartitionKey) == "" {
		return consistency.Options{}, nil, apperror.New("CONFIG_INVALID", "一致性扫描必须指定 scope 和 partition-key", nil)
	}
	return options, databaseArgs, nil
}
