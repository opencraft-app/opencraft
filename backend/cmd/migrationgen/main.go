// Command migrationgen 通过 Ent desired state 和 Atlas replay 生成版本化 migration。
// 它只在开发和 CI 中运行，不进入生产启动路径。
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	atlasmigrate "ariga.io/atlas/sql/migrate"
	"chatserver/internal/database/tdsqlbaseline"
	"chatserver/internal/ent/migrate"
	"entgo.io/ent/dialect"
	entschema "entgo.io/ent/dialect/sql/schema"
	modernsqlite "modernc.org/sqlite"
)

var validName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func init() {
	sql.Register("sqlite3", &modernsqlite.Driver{})
}

func main() {
	flags := flag.NewFlagSet("migrationgen", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	dialectName := flags.String("dialect", "sqlite", "sqlite 或 tdsql")
	hashOnly := flags.Bool("hash", false, "只重算 atlas.sum")
	verifyOnly := flags.Bool("verify", false, "只验证 TDSQL source/output/checksum 绑定")
	if err := flags.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}
	dialectValue, directory, err := parseDialect(*dialectName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "方言只支持 sqlite 或 tdsql")
		os.Exit(2)
	}
	root, err := projectRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法定位项目根目录")
		os.Exit(1)
	}
	if directory == "tdsql" {
		if *hashOnly {
			if flags.NArg() != 0 {
				fmt.Fprintln(os.Stderr, "tdsql --hash 不接受迁移名称")
				os.Exit(2)
			}
			if err := tdsqlbaseline.RewriteHashes(root); err != nil {
				fmt.Fprintf(os.Stderr, "重算 TDSQL migration checksum 失败：%v\n", err)
				os.Exit(1)
			}
			return
		}
		if *verifyOnly {
			if flags.NArg() != 0 {
				fmt.Fprintln(os.Stderr, "tdsql --verify 不接受迁移名称")
				os.Exit(2)
			}
			if err := tdsqlbaseline.VerifyFiles(root); err != nil {
				fmt.Fprintf(os.Stderr, "验证 TDSQL baseline 失败：%v\n", err)
				os.Exit(1)
			}
			return
		}
		if flags.NArg() != 1 || flags.Arg(0) != "baseline" {
			fmt.Fprintln(os.Stderr, "用法：go run ./cmd/migrationgen --dialect tdsql baseline")
			os.Exit(2)
		}
		if err := tdsqlbaseline.PublishFiles(root); err != nil {
			fmt.Fprintf(os.Stderr, "发布 TDSQL baseline 失败：%v\n", err)
			os.Exit(1)
		}
		return
	}
	if *verifyOnly {
		fmt.Fprintln(os.Stderr, "--verify 只适用于 tdsql")
		os.Exit(2)
	}
	if *hashOnly {
		if flags.NArg() != 0 {
			fmt.Fprintln(os.Stderr, "--hash 不接受迁移名称")
			os.Exit(2)
		}
		if err := rewriteHash(directory); err != nil {
			fmt.Fprintf(os.Stderr, "重算 migration checksum 失败：%v\n", err)
			os.Exit(1)
		}
		return
	}
	if flags.NArg() != 1 || !validName.MatchString(flags.Arg(0)) {
		fmt.Fprintln(os.Stderr, "用法：go run ./cmd/migrationgen --dialect sqlite <小写迁移名称>")
		os.Exit(2)
	}
	dir, err := atlasmigrate.NewLocalDir(filepath.Join(root, "migrations", directory))
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法打开 migration 目录")
		os.Exit(1)
	}
	err = migrate.NamedDiff(
		context.Background(),
		"sqlite://file?mode=memory&_fk=1&_pragma=foreign_keys(ON)",
		flags.Arg(0),
		entschema.WithDir(dir),
		entschema.WithMigrationMode(entschema.ModeReplay),
		entschema.WithDialect(dialectValue),
		entschema.WithForeignKeys(false),
		entschema.WithFormatter(atlasmigrate.DefaultFormatter),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "生成 migration 失败：%v\n", err)
		os.Exit(1)
	}
}

func rewriteHash(directory string) error {
	root, err := projectRoot()
	if err != nil {
		return err
	}
	dir, err := atlasmigrate.NewLocalDir(
		filepath.Join(root, "migrations", directory),
	)
	if err != nil {
		return err
	}
	files, err := dir.Files()
	if err != nil {
		return err
	}
	sum, err := atlasmigrate.NewHashFile(files)
	if err != nil {
		return err
	}
	return atlasmigrate.WriteSumFile(dir, sum)
}

func parseDialect(value string) (string, string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "sqlite":
		return dialect.SQLite, "sqlite", nil
	case "tdsql":
		return dialect.MySQL, "tdsql", nil
	default:
		return "", "", fmt.Errorf("unsupported dialect")
	}
}

func projectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found")
		}
		dir = parent
	}
}
