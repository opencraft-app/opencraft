//go:build darwin || linux

package filelock

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

var ErrLocked = errors.New("state is already owned by another process")

type Lock struct {
	file *os.File
	once sync.Once
	err  error
}

type BorrowedLease struct {
	file *os.File
	once sync.Once
	err  error
}

func Acquire(path string) (*Lock, error) {
	return AcquireExclusive(path)
}

func AcquireExclusive(path string) (*Lock, error) {
	return acquire(path, syscall.LOCK_EX)
}

func AcquireShared(path string) (*Lock, error) {
	return acquire(path, syscall.LOCK_SH)
}

func acquire(path string, mode int) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), mode|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return &Lock{file: file}, nil
}

func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() {
		if err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN); err != nil {
			l.err = err
		}
		if err := l.file.Close(); l.err == nil {
			l.err = err
		}
	})
	return l.err
}

func (l *Lock) DuplicateForInheritance() (*os.File, error) {
	if l == nil || l.file == nil {
		return nil, errors.New("cannot duplicate an empty lock")
	}
	fd, err := syscall.Dup(int(l.file.Fd()))
	if err != nil {
		return nil, err
	}
	syscall.CloseOnExec(fd)
	return os.NewFile(uintptr(fd), l.file.Name()+":inherited"), nil
}

func NewBorrowedLease(file *os.File) (*BorrowedLease, error) {
	if file == nil {
		return nil, errors.New("borrowed lease requires a file")
	}
	return &BorrowedLease{file: file}, nil
}

func (l *BorrowedLease) Close() error {
	if l == nil {
		return nil
	}
	l.once.Do(func() {
		l.err = l.file.Close()
	})
	return l.err
}
