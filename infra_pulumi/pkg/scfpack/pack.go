package scfpack

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var runtimeFiles = []string{"app.py", "requirements.txt"}

func ContentAddressedPath(source string) (string, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return "", fmt.Errorf("read SCF package for hashing: %w", err)
	}
	sum := sha256.Sum256(data)
	extension := filepath.Ext(source)
	base := strings.TrimSuffix(source, extension)
	target := base + "-" + hex.EncodeToString(sum[:8]) + extension
	if err := os.Rename(source, target); err != nil {
		return "", fmt.Errorf("rename SCF package to content-addressed path: %w", err)
	}
	return target, nil
}

func BuildPythonRuntimeZip(sourceDir, destination string) error {
	dependencies, err := os.MkdirTemp("", "lightvela-notify-scf-deps-")
	if err != nil {
		return fmt.Errorf("create SCF dependency directory: %w", err)
	}
	defer os.RemoveAll(dependencies)
	python := os.Getenv("SCF_BUILD_PYTHON")
	if python == "" {
		python = "python3"
	}
	command := exec.Command(
		python, "-m", "pip", "install",
		"--disable-pip-version-check",
		"--no-compile",
		"--no-deps",
		"--only-binary=:all:",
		"--platform", "manylinux2014_x86_64",
		"--python-version", "3.10",
		"--implementation", "cp",
		"--target", dependencies,
		"-r", filepath.Join(sourceDir, "requirements.txt"),
	)
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("install SCF Python dependencies: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return BuildRuntimeZipFromDependencies(sourceDir, dependencies, destination)
}

func BuildRuntimeZipFromDependencies(sourceDir, dependenciesDir, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return fmt.Errorf("create SCF build directory: %w", err)
	}
	output, err := os.Create(destination)
	if err != nil {
		return fmt.Errorf("create SCF runtime zip: %w", err)
	}
	writer := zip.NewWriter(output)
	for _, name := range runtimeFiles {
		if err := addFile(writer, filepath.Join(sourceDir, name), name); err != nil {
			writer.Close()
			output.Close()
			return err
		}
	}
	dependencyFiles := make([]string, 0)
	if err := filepath.WalkDir(dependenciesDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || strings.HasSuffix(path, ".pyc") || strings.Contains(filepath.ToSlash(path), "/__pycache__/") {
			return nil
		}
		dependencyFiles = append(dependencyFiles, path)
		return nil
	}); err != nil {
		writer.Close()
		output.Close()
		return fmt.Errorf("walk SCF dependencies: %w", err)
	}
	sort.Strings(dependencyFiles)
	for _, path := range dependencyFiles {
		name, err := filepath.Rel(dependenciesDir, path)
		if err != nil {
			writer.Close()
			output.Close()
			return fmt.Errorf("resolve SCF dependency path: %w", err)
		}
		if err := addFile(writer, path, filepath.ToSlash(name)); err != nil {
			writer.Close()
			output.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		output.Close()
		return fmt.Errorf("close SCF runtime zip: %w", err)
	}
	if err := output.Close(); err != nil {
		return fmt.Errorf("close SCF runtime file: %w", err)
	}
	return nil
}

func addFile(writer *zip.Writer, sourcePath, archiveName string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open SCF runtime file %s: %w", archiveName, err)
	}
	defer source.Close()
	header := &zip.FileHeader{Name: archiveName, Method: zip.Deflate}
	header.SetMode(0o644)
	header.SetModTime(time.Unix(0, 0).UTC())
	target, err := writer.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("create SCF zip entry %s: %w", archiveName, err)
	}
	if _, err := io.Copy(target, source); err != nil {
		return fmt.Errorf("write SCF zip entry %s: %w", archiveName, err)
	}
	return nil
}
