package tdsqlbaseline

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	atlasmigrate "ariga.io/atlas/sql/migrate"
)

const (
	atlasSumFilename   = "atlas.sum"
	compileSumFilename = "compile.sum"
)

// PublishFiles 从仓库中的固定 logical source 发布一次性 runtime baseline 与绑定文件。
// 任何目标已经存在都会拒绝，避免覆盖迁移历史。
func PublishFiles(root string) (returnErr error) {
	paths := artifactPaths(root)
	source, err := os.ReadFile(paths.sourceSQL)
	if err != nil {
		return fmt.Errorf("read logical source: %w", err)
	}
	artifact, err := Build(source)
	if err != nil {
		return err
	}
	sourceAtlasSum, err := atlasSum(Filename, source)
	if err != nil {
		return fmt.Errorf("hash logical source: %w", err)
	}
	outputAtlasSum, err := atlasSum(Filename, artifact.Output)
	if err != nil {
		return fmt.Errorf("hash runtime baseline: %w", err)
	}
	targets := []publishedFile{
		{path: paths.sourceAtlasSum, data: sourceAtlasSum},
		{path: paths.outputSQL, data: artifact.Output},
		{path: paths.outputAtlasSum, data: outputAtlasSum},
		{path: paths.compileSum, data: artifact.CompileSum},
	}
	for _, target := range targets {
		if _, err := os.Lstat(target.path); err == nil {
			return fmt.Errorf("refusing to overwrite published artifact %s", target.path)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(paths.outputSQL), 0o755); err != nil {
		return err
	}

	prepared := make([]preparedFile, 0, len(targets))
	created := make([]string, 0, len(targets))
	defer func() {
		if returnErr == nil {
			return
		}
		for _, file := range prepared {
			_ = os.Remove(file.temporary)
		}
		for _, file := range created {
			_ = os.Remove(file)
		}
	}()
	for _, target := range targets {
		file, err := prepareFile(target)
		if err != nil {
			return err
		}
		prepared = append(prepared, file)
	}
	for _, file := range prepared {
		if err := os.Rename(file.temporary, file.target); err != nil {
			return err
		}
		created = append(created, file.target)
	}
	for _, directory := range []string{filepath.Dir(paths.sourceSQL), filepath.Dir(paths.outputSQL)} {
		if err := syncDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

// VerifyFiles 重建全部内容，并逐字节核对 source/output/Atlas/compile 四重绑定。
func VerifyFiles(root string) error {
	paths := artifactPaths(root)
	source, err := os.ReadFile(paths.sourceSQL)
	if err != nil {
		return fmt.Errorf("read logical source: %w", err)
	}
	output, err := os.ReadFile(paths.outputSQL)
	if err != nil {
		return fmt.Errorf("read runtime baseline: %w", err)
	}
	compileSum, err := os.ReadFile(paths.compileSum)
	if err != nil {
		return fmt.Errorf("read compile.sum: %w", err)
	}
	if err := Verify(source, output, compileSum); err != nil {
		return err
	}
	if err := verifyAtlasDirectory(filepath.Dir(paths.sourceSQL)); err != nil {
		return fmt.Errorf("logical atlas.sum mismatch: %w", err)
	}
	if err := verifyAtlasDirectory(filepath.Dir(paths.outputSQL)); err != nil {
		return fmt.Errorf("runtime atlas.sum mismatch: %w", err)
	}
	return nil
}

// RewriteHashes 仅在发布新的增量 migration 后重算两个目录的 Atlas 索引。
// 它不会重写任何已发布 SQL 或 compile.sum。
func RewriteHashes(root string) error {
	paths := artifactPaths(root)
	for _, directory := range []string{filepath.Dir(paths.sourceSQL), filepath.Dir(paths.outputSQL)} {
		if err := rewriteAtlasDirectory(directory); err != nil {
			return err
		}
	}
	return nil
}

func verifyAtlasDirectory(directory string) error {
	dir, err := atlasmigrate.NewLocalDir(directory)
	if err != nil {
		return err
	}
	files, err := dir.Files()
	if err != nil {
		return err
	}
	expected, err := atlasmigrate.NewHashFile(files)
	if err != nil {
		return err
	}
	expectedBytes, err := expected.MarshalText()
	if err != nil {
		return err
	}
	actual, err := os.ReadFile(filepath.Join(directory, atlasSumFilename))
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, expectedBytes) {
		return fmt.Errorf("checksum differs")
	}
	return nil
}

func rewriteAtlasDirectory(directory string) error {
	dir, err := atlasmigrate.NewLocalDir(directory)
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

type paths struct {
	sourceSQL      string
	sourceAtlasSum string
	compileSum     string
	outputSQL      string
	outputAtlasSum string
}

func artifactPaths(root string) paths {
	sourceDir := filepath.Join(root, "internal", "database", "migrationsource", "tdsql")
	outputDir := filepath.Join(root, "migrations", "tdsql")
	return paths{
		sourceSQL:      filepath.Join(sourceDir, Filename),
		sourceAtlasSum: filepath.Join(sourceDir, atlasSumFilename),
		compileSum:     filepath.Join(sourceDir, compileSumFilename),
		outputSQL:      filepath.Join(outputDir, Filename),
		outputAtlasSum: filepath.Join(outputDir, atlasSumFilename),
	}
}

func atlasSum(name string, data []byte) ([]byte, error) {
	dir := atlasmigrate.OpenMemDir("chatserver-tdsql-baseline-hash")
	defer dir.Close()
	if err := dir.WriteFile(name, data); err != nil {
		return nil, err
	}
	files, err := dir.Files()
	if err != nil {
		return nil, err
	}
	sum, err := atlasmigrate.NewHashFile(files)
	if err != nil {
		return nil, err
	}
	return sum.MarshalText()
}

type publishedFile struct {
	path string
	data []byte
}

type preparedFile struct {
	temporary string
	target    string
}

func prepareFile(target publishedFile) (preparedFile, error) {
	file, err := os.CreateTemp(filepath.Dir(target.path), ".tdsql-publish-*")
	if err != nil {
		return preparedFile{}, err
	}
	temporary := file.Name()
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(temporary)
		}
	}()
	if err := file.Chmod(0o644); err != nil {
		return preparedFile{}, err
	}
	if _, err := file.Write(target.data); err != nil {
		return preparedFile{}, err
	}
	if err := file.Sync(); err != nil {
		return preparedFile{}, err
	}
	if err := file.Close(); err != nil {
		return preparedFile{}, err
	}
	ok = true
	return preparedFile{temporary: temporary, target: target.path}, nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
