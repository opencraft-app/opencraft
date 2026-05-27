package ext4sdk

import (
	"fmt"
	"os"
	"sync"
)

type FileBackend struct {
	mu         sync.Mutex
	file       *os.File
	blockSize  uint32
	blockCount uint64
}

func NewFileBackend(path string, blockSize uint32, blockCount uint64) (*FileBackend, error) {
	if path == "" {
		return nil, fmt.Errorf("ext4sdk file backend: empty path")
	}
	if blockSize == 0 || blockCount == 0 {
		return nil, fmt.Errorf("ext4sdk file backend: invalid geometry")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	size := int64(blockSize) * int64(blockCount)
	if err := f.Truncate(size); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &FileBackend{
		file:       f,
		blockSize:  blockSize,
		blockCount: blockCount,
	}, nil
}

func (b *FileBackend) BlockSize() uint32  { return b.blockSize }
func (b *FileBackend) BlockCount() uint64 { return b.blockCount }

func (b *FileBackend) ReadBlocks(blockID uint64, dst []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.file == nil {
		return ErrClosed
	}
	if len(dst)%int(b.blockSize) != 0 {
		return fmt.Errorf("ext4sdk file backend: misaligned read size %d", len(dst))
	}
	blockCount := uint64(len(dst) / int(b.blockSize))
	if blockID+blockCount > b.blockCount {
		return fmt.Errorf("ext4sdk file backend: read out of bounds")
	}
	_, err := b.file.ReadAt(dst, int64(blockID)*int64(b.blockSize))
	return err
}

func (b *FileBackend) WriteBlocks(blockID uint64, src []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.file == nil {
		return ErrClosed
	}
	if len(src)%int(b.blockSize) != 0 {
		return fmt.Errorf("ext4sdk file backend: misaligned write size %d", len(src))
	}
	blockCount := uint64(len(src) / int(b.blockSize))
	if blockID+blockCount > b.blockCount {
		return fmt.Errorf("ext4sdk file backend: write out of bounds")
	}
	_, err := b.file.WriteAt(src, int64(blockID)*int64(b.blockSize))
	return err
}

func (b *FileBackend) Sync() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.file == nil {
		return ErrClosed
	}
	return b.file.Sync()
}

func (b *FileBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.file == nil {
		return nil
	}
	err := b.file.Close()
	b.file = nil
	return err
}

