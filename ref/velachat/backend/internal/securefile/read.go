// Package securefile 读取本机 0600 或 Kubernetes 只读 Secret 文件。
package securefile

import (
	"errors"
	"os"
	"path/filepath"

	"chatserver/internal/apperror"
)

// Read 读取受限普通文件。允许 owner 写和 group 只读，但拒绝任何 group
// 写/执行与 world 权限，以兼容本机 0600 和 Secret volume 的 0440。
func Read(path string, label string, maxBytes int64) ([]byte, error) {
	if path == "" || label == "" || maxBytes <= 0 {
		return nil, apperror.New("CONFIG_INVALID", "安全文件配置无效", nil)
	}
	resolvedPath, info, err := resolve(path)
	if err != nil || !info.Mode().IsRegular() || !securePermissions(info.Mode().Perm()) ||
		info.Size() <= 0 || info.Size() > maxBytes {
		return nil, apperror.New(
			"CONFIG_INVALID",
			label+"文件权限或类型不安全",
			err,
		)
	}
	data, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, apperror.New("CONFIG_INVALID", "无法读取"+label+"文件", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, apperror.New("CONFIG_INVALID", label+"文件过大", errors.New("size changed"))
	}
	return data, nil
}

// resolve 接受普通文件，以及 Kubernetes projected Secret 固定生成的两级链接：
// <name> -> ..data/<name>，..data -> ..<revision>。最终文件必须仍位于同一挂载目录，
// 因而不会把任意符号链接放宽为可读取的凭据来源。
func resolve(path string) (string, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return path, info, nil
	}

	name := filepath.Base(path)
	linkTarget, err := os.Readlink(path)
	if err != nil || linkTarget != filepath.Join("..data", name) {
		return "", nil, errors.New("unsupported secret symlink")
	}

	mountDir, err := filepath.Abs(filepath.Dir(path))
	if err != nil {
		return "", nil, errors.New("invalid secret mount")
	}
	canonicalMount, err := filepath.EvalSymlinks(mountDir)
	if err != nil {
		return "", nil, errors.New("unresolved secret mount")
	}
	dataTarget, err := os.Readlink(filepath.Join(mountDir, "..data"))
	if err != nil || filepath.IsAbs(dataTarget) || filepath.Base(dataTarget) != dataTarget ||
		len(dataTarget) < 3 || dataTarget[:2] != ".." {
		return "", nil, errors.New("invalid projected secret revision")
	}

	expected := filepath.Join(canonicalMount, dataTarget, name)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", nil, errors.New("unresolved projected secret")
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil || resolved != expected {
		return "", nil, errors.New("projected secret escaped mount")
	}
	info, err = os.Lstat(resolved)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, errors.New("invalid projected secret file")
	}
	return resolved, info, nil
}

func securePermissions(mode os.FileMode) bool {
	return mode&0o400 != 0 && // owner 必须可读
		mode&0o137 == 0 // 拒绝 owner/group execute、group write 和全部 world 权限
}
