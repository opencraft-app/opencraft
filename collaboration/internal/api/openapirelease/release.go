// Package openapirelease promotes the two live OpenAPI documents into an
// immutable, digest-locked release baseline.
package openapirelease

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"

	"gopkg.in/yaml.v3"
)

const lockRelativePath = "platform/v1/releases/released.lock.json"

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type lockFile struct {
	FormatVersion int               `json:"formatVersion"`
	Files         map[string]string `json:"files"`
}

type sourceSpec struct {
	Info struct {
		Version string `yaml:"version"`
	} `yaml:"info"`
}

// Promote creates one immutable release. Re-running the same promotion is
// idempotent; changing any already released byte is rejected.
func Promote(root, version string) error {
	if root == "" || !versionPattern.MatchString(version) {
		return errors.New("OpenAPI release 参数无效")
	}
	lockPath := filepath.Join(root, lockRelativePath)
	lock, err := readLock(lockPath)
	if err != nil {
		return err
	}
	if err := Verify(root, lock); err != nil {
		return err
	}
	sources := []struct{ source, target string }{
		{"platform/v1/openapi.yaml", "platform/v1/releases/" + version + ".openapi.yaml"},
		{"platform/v1/computer-bootstrap.openapi.yaml", "platform/v1/releases/" + version + ".computer-bootstrap.openapi.yaml"},
	}
	type artifact struct {
		path   string
		data   []byte
		digest string
	}
	artifacts := make([]artifact, 0, len(sources))
	for _, item := range sources {
		data, err := os.ReadFile(filepath.Join(root, item.source))
		if err != nil {
			return err
		}
		var spec sourceSpec
		if err := yaml.Unmarshal(data, &spec); err != nil || spec.Info.Version != version {
			return fmt.Errorf("%s info.version 不是 %s", item.source, version)
		}
		digest := sha256Hex(data)
		if old, ok := lock.Files[item.target]; ok {
			if old != digest {
				return fmt.Errorf("已发布 OpenAPI %s 不可改写", item.target)
			}
		} else if existing, err := os.ReadFile(filepath.Join(root, item.target)); err == nil {
			if sha256Hex(existing) != digest {
				return fmt.Errorf("未受信的 release 文件 %s 已存在", item.target)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		artifacts = append(artifacts, artifact{path: item.target, data: data, digest: digest})
	}
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return err
	}
	for _, artifact := range artifacts {
		path := filepath.Join(root, artifact.path)
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := atomicWrite(path, artifact.data, 0o644); err != nil {
				return err
			}
		}
		lock.Files[artifact.path] = artifact.digest
	}
	encoded, err := json.MarshalIndent(lock, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return atomicWrite(lockPath, encoded, 0o644)
}

// Verify checks the exact released file set and every recorded digest.
func Verify(root string, expected lockFile) error {
	if expected.FormatVersion != 1 || expected.Files == nil {
		return errors.New("OpenAPI release lock 格式无效")
	}
	releases := filepath.Join(root, "platform/v1/releases")
	entries, err := os.ReadDir(releases)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	actualCount := 0
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == "released.lock.json" {
			continue
		}
		actualCount++
		relative := filepath.ToSlash(filepath.Join("platform/v1/releases", entry.Name()))
		digest, ok := expected.Files[relative]
		if !ok {
			return fmt.Errorf("未登记的 OpenAPI release: %s", relative)
		}
		data, err := os.ReadFile(filepath.Join(root, relative))
		if err != nil {
			return err
		}
		if sha256Hex(data) != digest {
			return fmt.Errorf("OpenAPI release digest 不匹配: %s", relative)
		}
	}
	if actualCount != len(expected.Files) {
		return errors.New("OpenAPI release lock 存在缺失文件")
	}
	return nil
}

// VerifyRoot verifies the repository lock on disk.
func VerifyRoot(root string) error {
	lock, err := readLock(filepath.Join(root, lockRelativePath))
	if err != nil {
		return err
	}
	return Verify(root, lock)
}

// VerifyTrustedBase proves that the current lock is append-only relative to a
// lock obtained from a protected default branch.
func VerifyTrustedBase(root, trustedBaseLockPath string) error {
	current, err := readLock(filepath.Join(root, lockRelativePath))
	if err != nil {
		return err
	}
	if err := Verify(root, current); err != nil {
		return err
	}
	base, err := readLock(trustedBaseLockPath)
	if err != nil {
		return err
	}
	for path, digest := range base.Files {
		currentDigest, ok := current.Files[path]
		if !ok || !reflect.DeepEqual(currentDigest, digest) {
			return fmt.Errorf("OpenAPI release lock 只能追加，旧 entry %s 被删除或修改", path)
		}
	}
	return nil
}

func readLock(path string) (lockFile, error) {
	lock := lockFile{FormatVersion: 1, Files: map[string]string{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return lock, nil
	}
	if err != nil {
		return lockFile{}, err
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return lockFile{}, err
	}
	return lock, nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".openapi-release-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func sha256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
