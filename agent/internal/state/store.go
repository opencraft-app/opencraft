package state

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

var ErrUnsafePath = errors.New("state path must remain inside the state root")

type Store struct {
	root string
}

func New(root string) *Store {
	return &Store{root: filepath.Clean(root)}
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) Read(relativePath string, destination any) error {
	cleanPath, err := cleanRelativePath(relativePath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(s.root, cleanPath))
	if err != nil {
		return err
	}
	return common.Unmarshal(data, destination)
}

func (s *Store) Write(relativePath string, value any) error {
	data, err := common.Marshal(value)
	if err != nil {
		return err
	}
	return s.WriteFile(relativePath, data, 0o600)
}

func (s *Store) WriteFile(relativePath string, data []byte, mode os.FileMode) error {
	cleanPath, err := cleanRelativePath(relativePath)
	if err != nil {
		return err
	}
	if mode != 0o600 && mode != 0o700 {
		return errors.New("state file mode must be 0600 or 0700")
	}

	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(s.root, 0o700); err != nil {
		return err
	}

	destination := filepath.Join(s.root, cleanPath)
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}

	temp, err := os.CreateTemp(directory, ".state-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, destination); err != nil {
		return err
	}
	if err := os.Chmod(destination, mode); err != nil {
		return err
	}

	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer directoryHandle.Close()
	return directoryHandle.Sync()
}

func (s *Store) Remove(relativePath string) error {
	cleanPath, err := cleanRelativePath(relativePath)
	if err != nil {
		return err
	}
	destination := filepath.Join(s.root, cleanPath)
	if err := os.Remove(destination); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	directoryHandle, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer directoryHandle.Close()
	return directoryHandle.Sync()
}

func cleanRelativePath(relativePath string) (string, error) {
	cleanPath := filepath.Clean(relativePath)
	if cleanPath == "." || filepath.IsAbs(cleanPath) || cleanPath == ".." ||
		strings.HasPrefix(cleanPath, ".."+string(filepath.Separator)) {
		return "", ErrUnsafePath
	}
	return cleanPath, nil
}
