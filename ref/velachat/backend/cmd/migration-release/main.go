package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"chatserver/internal/database/migration"
)

func main() {
	root := flag.String("root", ".", "仓库根目录")
	verify := flag.Bool("verify", false, "只验证 migration release lock")
	trustedBase := flag.String("trusted-base", "", "可信默认分支的 release lock")
	flag.Parse()

	lockPath := filepath.Join(*root, "migrations", "released.lock.json")
	if *verify {
		if err := migration.VerifyReleaseLock(*root, lockPath, *trustedBase); err != nil {
			fmt.Fprintln(os.Stderr, "Migration release 验证失败："+err.Error())
			os.Exit(1)
		}
		fmt.Println("Migration release lock 验证通过")
		return
	}
	if err := migration.PromoteReleaseLock(*root, lockPath); err != nil {
		fmt.Fprintln(os.Stderr, "Migration 发布失败："+err.Error())
		os.Exit(1)
	}
	fmt.Println("Migration release lock 已更新")
}
