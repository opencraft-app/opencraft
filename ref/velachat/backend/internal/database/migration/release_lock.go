package migration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
)

const releaseLockSchemaVersion = 1

// ReleaseLock 冻结所有已经进入仓库的数据库迁移源。
type ReleaseLock struct {
	SchemaVersion int                `json:"schemaVersion"`
	Entries       []ReleaseLockEntry `json:"entries"`
}

// ReleaseLockEntry 把路径、方言、逻辑变更与真实字节绑定。
type ReleaseLockEntry struct {
	Dialect            string   `json:"dialect"`
	Path               string   `json:"path"`
	SHA256             string   `json:"sha256"`
	MigrationID        string   `json:"migrationId"`
	LogicalMigration   string   `json:"logicalMigration"`
	IncludedInBaseline []string `json:"includedInBaseline,omitempty"`
}

// VerifyReleaseLock 验证当前树，并可与可信默认分支的 lock 做 append-only 对账。
func VerifyReleaseLock(repositoryRoot, lockPath, trustedBaseLockPath string) error {
	current, err := readReleaseLock(lockPath)
	if err != nil {
		return err
	}
	if err := verifyCurrentReleaseLock(repositoryRoot, current); err != nil {
		return err
	}
	if trustedBaseLockPath == "" {
		return nil
	}
	base, err := readReleaseLock(trustedBaseLockPath)
	if err != nil {
		return fmt.Errorf("读取可信 base release lock: %w", err)
	}
	currentByPath := make(map[string]ReleaseLockEntry, len(current.Entries))
	for _, entry := range current.Entries {
		currentByPath[entry.Path] = entry
	}
	for _, old := range base.Entries {
		value, exists := currentByPath[old.Path]
		if !exists || !reflect.DeepEqual(value, old) {
			return fmt.Errorf("release lock 只能追加，旧 entry %s 被删除或修改", old.Path)
		}
	}
	return nil
}

// PromoteReleaseLock 只供显式发布流程使用；普通生成流程不得调用。
func PromoteReleaseLock(repositoryRoot, lockPath string) error {
	existing := ReleaseLock{SchemaVersion: releaseLockSchemaVersion}
	if _, err := os.Stat(lockPath); err == nil {
		loaded, loadErr := readReleaseLock(lockPath)
		if loadErr != nil {
			return loadErr
		}
		existing = loaded
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	existingByPath := make(map[string]ReleaseLockEntry, len(existing.Entries))
	for _, entry := range existing.Entries {
		existingByPath[entry.Path] = entry
	}
	paths, err := migrationSourcePaths(repositoryRoot)
	if err != nil {
		return err
	}
	entries := make([]ReleaseLockEntry, 0, len(paths))
	for _, path := range paths {
		digest, digestErr := fileSHA256(filepath.Join(repositoryRoot, filepath.FromSlash(path)))
		if digestErr != nil {
			return digestErr
		}
		entry, exists := existingByPath[path]
		if !exists {
			entry = inferredReleaseEntry(path)
		}
		entry.Path = path
		entry.Dialect = dialectForPath(path)
		entry.SHA256 = digest
		entries = append(entries, entry)
	}
	slices.SortFunc(entries, func(a, b ReleaseLockEntry) int { return strings.Compare(a.Path, b.Path) })
	value := ReleaseLock{SchemaVersion: releaseLockSchemaVersion, Entries: entries}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(lockPath), ".released.lock-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, lockPath)
}

func verifyCurrentReleaseLock(repositoryRoot string, lock ReleaseLock) error {
	paths, err := migrationSourcePaths(repositoryRoot)
	if err != nil {
		return err
	}
	want := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		want[path] = struct{}{}
	}
	seen := make(map[string]struct{}, len(lock.Entries))
	entriesByPath := make(map[string]ReleaseLockEntry, len(lock.Entries))
	for _, entry := range lock.Entries {
		entriesByPath[entry.Path] = entry
	}
	for _, entry := range lock.Entries {
		if entry.Path == "" || entry.MigrationID == "" || entry.LogicalMigration == "" {
			return fmt.Errorf("release lock entry 定义不完整: %#v", entry)
		}
		if _, exists := seen[entry.Path]; exists {
			return fmt.Errorf("release lock 路径 %s 重复", entry.Path)
		}
		seen[entry.Path] = struct{}{}
		if _, exists := want[entry.Path]; !exists {
			return fmt.Errorf("release lock 文件 %s 不存在或不属于迁移源", entry.Path)
		}
		if entry.Dialect != dialectForPath(entry.Path) {
			return fmt.Errorf("release lock %s dialect = %s，期望 %s", entry.Path, entry.Dialect, dialectForPath(entry.Path))
		}
		digest, digestErr := fileSHA256(filepath.Join(repositoryRoot, filepath.FromSlash(entry.Path)))
		if digestErr != nil {
			return digestErr
		}
		if entry.SHA256 != digest {
			return fmt.Errorf("release lock %s digest 不匹配", entry.Path)
		}
		for _, baseline := range entry.IncludedInBaseline {
			target, exists := entriesByPath[baseline]
			if !exists {
				return fmt.Errorf("release lock %s 引用未冻结 baseline %s", entry.Path, baseline)
			}
			if baseline == entry.Path || (target.Dialect != "tdsql-runtime" && target.Dialect != "tdsql-source") {
				return fmt.Errorf("release lock %s 的 baseline 引用无效: %s", entry.Path, baseline)
			}
		}
	}
	for _, path := range paths {
		if _, exists := seen[path]; !exists {
			return fmt.Errorf("migration %s 未进入 release lock", path)
		}
	}
	return nil
}

func readReleaseLock(path string) (ReleaseLock, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ReleaseLock{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var lock ReleaseLock
	if err := decoder.Decode(&lock); err != nil {
		return ReleaseLock{}, fmt.Errorf("解析 release lock: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != nil && !errors.Is(err, io.EOF) {
		return ReleaseLock{}, fmt.Errorf("解析 release lock 尾部: %w", err)
	} else if err == nil {
		return ReleaseLock{}, errors.New("release lock 只能包含一个 JSON value")
	}
	if lock.SchemaVersion != releaseLockSchemaVersion {
		return ReleaseLock{}, fmt.Errorf("release lock schemaVersion = %d", lock.SchemaVersion)
	}
	return lock, nil
}

func migrationSourcePaths(root string) ([]string, error) {
	searchRoots := []string{"migrations", "internal/database/migrationsource/tdsql"}
	paths := make([]string, 0)
	for _, relativeRoot := range searchRoots {
		absoluteRoot := filepath.Join(root, filepath.FromSlash(relativeRoot))
		info, err := os.Stat(absoluteRoot)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("migration root %s 不是目录", relativeRoot)
		}
		err = filepath.WalkDir(absoluteRoot, func(path string, item os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if item.IsDir() {
				return nil
			}
			name := item.Name()
			if filepath.Ext(name) != ".sql" && !(relativeRoot == "internal/database/migrationsource/tdsql" && name == "compile.sum") {
				return nil
			}
			relative, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			paths = append(paths, filepath.ToSlash(relative))
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(paths)
	return paths, nil
}

func inferredReleaseEntry(path string) ReleaseLockEntry {
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	migrationID := name
	logical := name
	if filepath.Base(path) == "compile.sum" {
		migrationID = "compile-sum"
		logical = "tdsql-compile-binding"
	}
	return ReleaseLockEntry{MigrationID: migrationID, LogicalMigration: logical}
}

func dialectForPath(path string) string {
	switch {
	case strings.HasPrefix(path, "internal/database/migrationsource/tdsql/"):
		return "tdsql-source"
	case strings.HasPrefix(path, "migrations/tdsql/"):
		return "tdsql-runtime"
	default:
		return "sqlite"
	}
}

func fileSHA256(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}
