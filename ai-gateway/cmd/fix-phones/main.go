// fix-phones 是一次性数据修复工具，用于在 migration 000011 迁移后补全旧用户的手机号字段。
//
// 背景：migration 000011 将 phone 字段替换为 phone_encrypted / phone_hash / phone_masked，
// 但迁移时未对存量用户数据进行转换，导致旧用户三个字段均为空字符串。
//
// 用法：
//
//	# 通过 CSV 批量修复（推荐）
//	ENCRYPTION_KEY=<32字节密钥> ./fix-phones --dsn "root:***@tcp(127.0.0.1:3306)/ai_gateway?charset=utf8mb4&parseTime=True&loc=UTC&time_zone=%27%2B00%3A00%27" --csv phones.csv
//
//	# 修复单个用户
//	ENCRYPTION_KEY=<32字节密钥> ./fix-phones --dsn "root:***@tcp(127.0.0.1:3306)/ai_gateway?charset=utf8mb4&parseTime=True&loc=UTC&time_zone=%27%2B00%3A00%27" --user-id <uuid> --phone 13812341234
//
//	# 仅预览，不写入（dry-run）
//	ENCRYPTION_KEY=<32字节密钥> ./fix-phones --dsn "root:***@tcp(127.0.0.1:3306)/ai_gateway?charset=utf8mb4&parseTime=True&loc=UTC&time_zone=%27%2B00%3A00%27" --csv phones.csv --dry-run
//
// CSV 格式（首行为表头，可选）：
//
//	user_id,phone
//	550e8400-e29b-41d4-a716-446655440000,13812341234
package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"git.woa.com/wisp/mono/ai-gateway/internal/pkg/crypto"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	var (
		dsn    = flag.String("dsn", os.Getenv("DATABASE_URL"), "MySQL DSN（或设置 DATABASE_URL 环境变量）")
		csvFile = flag.String("csv", "", "CSV 文件路径，格式：user_id,phone")
		userID = flag.String("user-id", "", "单用户 UUID")
		phone  = flag.String("phone", "", "单用户明文手机号")
		dryRun = flag.Bool("dry-run", false, "预览模式，不实际写入数据库")
	)
	flag.Parse()

	// 获取加密密钥
	encKey := os.Getenv("ENCRYPTION_KEY")
	if len(encKey) != 32 {
		log.Fatalf("ENCRYPTION_KEY 环境变量必须为 32 字节，当前长度：%d", len(encKey))
	}
	key := []byte(encKey)

	if *dsn == "" {
		log.Fatal("必须通过 --dsn 或 DATABASE_URL 环境变量指定数据库连接")
	}

	// 收集要处理的 (user_id, phone) 列表
	type entry struct {
		userID string
		phone  string
	}
	var entries []entry

	if *csvFile != "" {
		f, err := os.Open(*csvFile)
		if err != nil {
			log.Fatalf("无法打开 CSV 文件 %s: %v", *csvFile, err)
		}
		defer f.Close()

		r := csv.NewReader(f)
		lineNum := 0
		for {
			record, err := r.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				log.Fatalf("读取 CSV 第 %d 行失败: %v", lineNum+1, err)
			}
			lineNum++
			if len(record) < 2 {
				log.Printf("跳过第 %d 行（字段不足）: %v", lineNum, record)
				continue
			}
			uid := strings.TrimSpace(record[0])
			ph := strings.TrimSpace(record[1])
			// 跳过表头
			if lineNum == 1 && (uid == "user_id" || uid == "id") {
				continue
			}
			if uid == "" || ph == "" {
				log.Printf("跳过第 %d 行（空字段）: %v", lineNum, record)
				continue
			}
			entries = append(entries, entry{uid, ph})
		}
	} else if *userID != "" && *phone != "" {
		entries = append(entries, entry{*userID, *phone})
	} else {
		flag.Usage()
		log.Fatal("必须通过 --csv 或同时指定 --user-id + --phone 来提供数据")
	}

	if len(entries) == 0 {
		log.Fatal("没有可处理的记录")
	}

	// 连接数据库
	db, err := sql.Open("pgx", *dsn)
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	defer db.Close()

	if err := db.PingContext(context.Background()); err != nil {
		log.Fatalf("数据库 ping 失败: %v", err)
	}

	fmt.Printf("共 %d 条记录待处理", len(entries))
	if *dryRun {
		fmt.Print("（dry-run 模式，不写入）")
	}
	fmt.Println()

	var successCount, failCount int

	for _, e := range entries {
		// 验证手机号格式
		if !crypto.IsFullPhone(e.phone) {
			log.Printf("[SKIP] user_id=%s phone=%s — 不是有效的 11 位手机号", e.userID, e.phone)
			failCount++
			continue
		}

		// 生成三个字段
		encrypted, err := crypto.Encrypt(e.phone, key)
		if err != nil {
			log.Printf("[ERROR] user_id=%s — 加密失败: %v", e.userID, err)
			failCount++
			continue
		}
		hashed := crypto.HashPhone(e.phone)
		masked := crypto.MaskPhone(e.phone)

		if *dryRun {
			fmt.Printf("[DRY-RUN] user_id=%s phone=%s → masked=%s hash=%s...\n",
				e.userID, e.phone, masked, hashed[:8])
			successCount++
			continue
		}

		// 写入数据库
		ctx := context.Background()
		result, err := db.ExecContext(ctx,
			`UPDATE users SET phone_encrypted=$1, phone_hash=$2, phone_masked=$3 WHERE id=$4`,
			encrypted, hashed, masked, e.userID,
		)
		if err != nil {
			log.Printf("[ERROR] user_id=%s — 写入失败: %v", e.userID, err)
			failCount++
			continue
		}
		rows, _ := result.RowsAffected()
		if rows == 0 {
			log.Printf("[WARN] user_id=%s — 未找到该用户（0 行更新）", e.userID)
			failCount++
			continue
		}

		fmt.Printf("[OK] user_id=%s → %s\n", e.userID, masked)
		successCount++
	}

	fmt.Printf("\n完成：成功 %d，失败/跳过 %d\n", successCount, failCount)
	if failCount > 0 {
		os.Exit(1)
	}
}
