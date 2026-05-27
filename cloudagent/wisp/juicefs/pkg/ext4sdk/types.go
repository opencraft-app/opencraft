package ext4sdk

import (
	"errors"
	"io"
)

var (
	ErrUnavailable = errors.New("ext4sdk unavailable: build with -tags lwext4sdk on linux with cgo and provide third_party/lwext4")
	ErrClosed      = errors.New("ext4sdk closed")
)

// BlockBackend provides block-level IO for lwext4.
// Implementations can be backed by a regular file, a sparse file, or a
// higher-level virtual block device implemented on top of JuiceFS.
type BlockBackend interface {
	BlockSize() uint32
	BlockCount() uint64
	ReadBlocks(blockID uint64, dst []byte) error
	WriteBlocks(blockID uint64, src []byte) error
	Sync() error
	Close() error
}

type FilesystemType int

const (
	Ext2 FilesystemType = 2
	Ext3 FilesystemType = 3
	Ext4 FilesystemType = 4
)

type Options struct {
	DeviceName  string
	MountPoint  string
	CacheItems  uint32
	Recover     bool
	WriteBack   bool
}

type FormatOptions struct {
	Type      FilesystemType
	Length    uint64
	BlockSize uint32
	Journal   bool
	Label     string
}

type MountStats struct {
	InodesCount     uint32
	FreeInodesCount uint32
	BlocksCount     uint64
	FreeBlocksCount uint64
	BlockSize       uint32
	BlockGroupCount uint32
	BlocksPerGroup  uint32
	InodesPerGroup  uint32
	VolumeName      string
}

type DirEntry struct {
	Inode uint32
	Type  uint8
	Name  string
}

type File interface {
	io.Reader
	io.Writer
	io.Seeker
	Size() uint64
	Close() error
	Truncate(size uint64) error
}

type Dir interface {
	Next() (*DirEntry, error)
	Close() error
}

