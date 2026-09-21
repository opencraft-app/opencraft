// Package mysqlmigrations appends a bound single-instance MySQL migration line.
package mysqlmigrations

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	atlas "ariga.io/atlas/sql/migrate"
	"git.woa.com/wisp/mono2/collaboration/internal/database/tdsqlddl"
)

func artifacts(root string) (map[string][]byte, error) {
	data, err := os.ReadFile(filepath.Join(root, "migrations/released.lock.json"))
	if err != nil {
		return nil, err
	}
	var lock struct {
		Entries []struct{ Path, SHA256 string }
	}
	if err := json.Unmarshal(data, &lock); err != nil {
		return nil, err
	}
	frozen := map[string]string{}
	for _, entry := range lock.Entries {
		frozen[entry.Path] = entry.SHA256
	}
	dir, err := atlas.NewLocalDir(filepath.Join(root, "migrations/tdsql"))
	if err != nil {
		return nil, err
	}
	if err := atlas.Validate(dir); err != nil {
		return nil, err
	}
	files, err := dir.Files()
	if err != nil {
		return nil, err
	}
	result := map[string][]byte{}
	for _, file := range files {
		source := file.Bytes()
		path := "migrations/tdsql/" + file.Name()
		if frozen[path] != fmt.Sprintf("%x", sha256.Sum256(source)) {
			return nil, fmt.Errorf("source is not frozen: %s", path)
		}
		statements, err := file.Stmts()
		if err != nil {
			return nil, err
		}
		for index, statement := range statements {
			if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(statement)), "CREATE TABLE") {
				statements[index], err = tdsqlddl.WithoutPhysicalSharding(statement)
				if err != nil {
					return nil, fmt.Errorf("%s: %w", file.Name(), err)
				}
			}
		}
		output := []byte(strings.Join(statements, ";\n\n") + ";\n")
		result[file.Name()] = output
		result[file.Name()+".source.sum"] = []byte(fmt.Sprintf("compiler=mysql-storage/v1 source=%s source_sha256=%x output_sha256=%x\n", path, sha256.Sum256(source), sha256.Sum256(output)))
	}
	return result, nil
}

// Publish only appends absent artifacts. Existing bytes must match exactly.
func Publish(root, target string) error {
	files, err := artifacts(root)
	if err != nil {
		return err
	}
	for name, data := range files {
		path := filepath.Join(target, name)
		old, err := os.ReadFile(path)
		if err == nil && !bytes.Equal(old, data) {
			return fmt.Errorf("refuse published artifact overwrite: %s", name)
		}
		if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	for name, data := range files {
		path := filepath.Join(target, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if os.IsExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		_, writeErr := file.Write(data)
		syncErr := file.Sync()
		closeErr := file.Close()
		if writeErr != nil {
			return writeErr
		}
		if syncErr != nil {
			return syncErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	dir, err := atlas.NewLocalDir(target)
	if err != nil {
		return err
	}
	listed, err := dir.Files()
	if err != nil {
		return err
	}
	sum, err := atlas.NewHashFile(listed)
	if err != nil {
		return err
	}
	return atlas.WriteSumFile(dir, sum)
}

func Verify(root, target string) error {
	files, err := artifacts(root)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "atlas.sum" {
			continue
		}
		if _, ok := files[entry.Name()]; !ok {
			return fmt.Errorf("unknown MySQL migration artifact: %s", entry.Name())
		}
	}
	for name, data := range files {
		old, err := os.ReadFile(filepath.Join(target, name))
		if err != nil {
			return err
		}
		if !bytes.Equal(old, data) {
			return fmt.Errorf("MySQL source/output binding mismatch: %s", name)
		}
	}
	dir, err := atlas.NewLocalDir(target)
	if err != nil {
		return err
	}
	return atlas.Validate(dir)
}
