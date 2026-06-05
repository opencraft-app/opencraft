package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	pathpkg "path"
	"path/filepath"
	"strconv"
	"strings"
)

type requestEnvelope struct {
	Path     string `json:"path"`
	NewPath  string `json:"new_path,omitempty"`
	Content  string `json:"content,omitempty"`
	Encoding string `json:"encoding,omitempty"`
	Mode     string `json:"mode,omitempty"`
}

type responseEnvelope struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Code   string `json:"code,omitempty"`
	Error  string `json:"error,omitempty"`
}

type entry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	Mode string `json:"mode,omitempty"`
}

type fileContent struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
}

func main() {
	if len(os.Args) < 2 {
		writeError("invalid_request", "usage: wisp-fs-agent <list|read|write|write-raw|mkdir|rename|delete|stat>")
		os.Exit(2)
	}
	if os.Args[1] == "write-raw" {
		if len(os.Args) < 3 || len(os.Args) > 4 {
			writeError("invalid_request", "usage: wisp-fs-agent write-raw <path> [mode]")
			os.Exit(2)
		}
		if err := writeRawPath(os.Args[2], rawModeArg(os.Args)); err != nil {
			code, message, exitCode := classifyError(err)
			writeError(code, message)
			os.Exit(exitCode)
		}
		writeOK(nil)
		return
	}
	if len(os.Args) != 2 {
		writeError("invalid_request", "usage: wisp-fs-agent <list|read|write|write-raw|mkdir|rename|delete|stat>")
		os.Exit(2)
	}
	var req requestEnvelope
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError("invalid_request", "invalid JSON request")
		os.Exit(2)
	}
	var result any
	var err error
	switch os.Args[1] {
	case "list":
		result, err = listPath(req.Path)
	case "read":
		result, err = readPath(req.Path)
	case "write":
		err = writePath(req)
	case "mkdir":
		err = mkdirPath(req.Path, req.Mode)
	case "rename":
		err = renamePath(req.Path, req.NewPath)
	case "delete":
		err = deletePath(req.Path)
	case "stat":
		result, err = statPath(req.Path)
	default:
		writeError("invalid_request", "unsupported verb")
		os.Exit(2)
	}
	if err != nil {
		code, message, exitCode := classifyError(err)
		writeError(code, message)
		os.Exit(exitCode)
	}
	writeOK(result)
}

func listPath(raw string) (any, error) {
	target, err := normalize(raw)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errNotDirectory
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	out := make([]entry, 0, len(entries))
	for _, item := range entries {
		info, err := item.Info()
		if err != nil {
			return nil, err
		}
		itemPath := pathpkg.Join(target, item.Name())
		out = append(out, buildEntry(itemPath, info))
	}
	return out, nil
}

func readPath(raw string) (any, error) {
	target, err := normalize(raw)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, errNotFile
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	return fileContent{
		Path:     target,
		Content:  base64.StdEncoding.EncodeToString(data),
		Encoding: "base64",
	}, nil
}

func writePath(req requestEnvelope) error {
	target, err := normalize(req.Path)
	if err != nil {
		return err
	}
	var data []byte
	switch strings.TrimSpace(req.Encoding) {
	case "", "utf-8":
		data = []byte(req.Content)
	case "base64":
		data, err = base64.StdEncoding.DecodeString(req.Content)
		if err != nil {
			return errInvalidRequest
		}
	default:
		return errInvalidRequest
	}
	if err := os.MkdirAll(pathpkg.Dir(target), 0o755); err != nil {
		return err
	}
	return os.WriteFile(target, data, 0o644)
}

func writeRawPath(raw, rawMode string) error {
	target, err := normalize(raw)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if strings.TrimSpace(rawMode) != "" {
		parsed, err := strconv.ParseUint(rawMode, 8, 32)
		if err != nil {
			return errInvalidRequest
		}
		mode = os.FileMode(parsed)
	}
	dir := pathpkg.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(target)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.Copy(tmp, os.Stdin); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, target)
}

func rawModeArg(args []string) string {
	if len(args) >= 4 {
		return args[3]
	}
	return ""
}

func mkdirPath(raw, rawMode string) error {
	target, err := normalize(raw)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o755)
	if strings.TrimSpace(rawMode) != "" {
		parsed, err := strconv.ParseUint(rawMode, 8, 32)
		if err != nil {
			return errInvalidRequest
		}
		mode = os.FileMode(parsed)
	}
	return os.MkdirAll(target, mode)
}

func renamePath(oldRaw, newRaw string) error {
	oldPath, err := normalize(oldRaw)
	if err != nil {
		return err
	}
	newPath, err := normalize(newRaw)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(pathpkg.Dir(newPath), 0o755); err != nil {
		return err
	}
	return os.Rename(oldPath, newPath)
}

func deletePath(raw string) error {
	target, err := normalize(raw)
	if err != nil {
		return err
	}
	return os.RemoveAll(target)
}

func statPath(raw string) (any, error) {
	target, err := normalize(raw)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, err
	}
	return buildEntry(target, info), nil
}

func buildEntry(target string, info os.FileInfo) entry {
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	}
	return entry{
		Path: target,
		Type: kind,
		Size: info.Size(),
		Mode: info.Mode().String(),
	}
}

var (
	errInvalidPath    = errors.New("invalid_path")
	errInvalidRequest = errors.New("invalid_request")
	errNotDirectory   = errors.New("not_a_directory")
	errNotFile        = errors.New("not_a_file")
)

func normalize(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errInvalidPath
	}
	if !strings.HasPrefix(raw, "/") {
		return "", errInvalidPath
	}
	if strings.ContainsRune(raw, '\x00') {
		return "", errInvalidPath
	}
	for _, part := range strings.Split(raw, "/") {
		if part == ".." {
			return "", errInvalidPath
		}
	}
	clean := pathpkg.Clean(raw)
	if !strings.HasPrefix(clean, "/") {
		return "", errInvalidPath
	}
	return clean, nil
}

func classifyError(err error) (string, string, int) {
	switch {
	case errors.Is(err, errInvalidPath):
		return "invalid_path", "filesystem path is invalid", 2
	case errors.Is(err, errInvalidRequest):
		return "invalid_request", "filesystem request is invalid", 2
	case errors.Is(err, errNotDirectory):
		return "not_a_directory", "target is not a directory", 4
	case errors.Is(err, errNotFile):
		return "not_a_file", "target is not a file", 4
	case os.IsNotExist(err):
		return "path_not_found", "filesystem path not found", 3
	case os.IsPermission(err):
		return "permission_denied", "filesystem permission denied", 5
	default:
		return "filesystem_agent_failed", err.Error(), 1
	}
}

func writeOK(result any) {
	_ = json.NewEncoder(os.Stdout).Encode(responseEnvelope{OK: true, Result: result})
}

func writeError(code, message string) {
	_ = json.NewEncoder(os.Stdout).Encode(responseEnvelope{OK: false, Code: code, Error: message})
}
