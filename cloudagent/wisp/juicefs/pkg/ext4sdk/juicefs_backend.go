package ext4sdk

import (
	"fmt"
	"io"
	"path"
	"sync"
	"syscall"

	juicefs "github.com/juicedata/juicefs/pkg/fs"
	"github.com/juicedata/juicefs/pkg/meta"
)

// JuiceFSFileBackend stores an lwext4 block device inside a regular JuiceFS file.
// The backend keeps one writable file handle open and serializes block IO.
type JuiceFSFileBackend struct {
	mu         sync.Mutex
	jfs        *juicefs.FileSystem
	ctx        meta.Context
	path       string
	blockSize  uint32
	blockCount uint64
	file       *juicefs.File
}

func NewJuiceFSFileBackend(jfs *juicefs.FileSystem, ctx meta.Context, filePath string, blockSize uint32, blockCount uint64) (*JuiceFSFileBackend, error) {
	if jfs == nil {
		return nil, fmt.Errorf("ext4sdk juicefs backend: nil filesystem")
	}
	if ctx == nil {
		return nil, fmt.Errorf("ext4sdk juicefs backend: nil context")
	}
	if filePath == "" {
		return nil, fmt.Errorf("ext4sdk juicefs backend: empty path")
	}
	if blockSize == 0 || blockCount == 0 {
		return nil, fmt.Errorf("ext4sdk juicefs backend: invalid geometry")
	}
	if filePath[0] != '/' {
		filePath = "/" + filePath
	}
	b := &JuiceFSFileBackend{
		jfs:        jfs,
		ctx:        ctx,
		path:       path.Clean(filePath),
		blockSize:  blockSize,
		blockCount: blockCount,
	}
	if err := b.ensureFileLocked(); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *JuiceFSFileBackend) BlockSize() uint32  { return b.blockSize }
func (b *JuiceFSFileBackend) BlockCount() uint64 { return b.blockCount }

func (b *JuiceFSFileBackend) ReadBlocks(blockID uint64, dst []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(dst)%int(b.blockSize) != 0 {
		return fmt.Errorf("ext4sdk juicefs backend: misaligned read size %d", len(dst))
	}
	if err := b.ensureFileLocked(); err != nil {
		return err
	}
	blockCount := uint64(len(dst) / int(b.blockSize))
	if blockID+blockCount > b.blockCount {
		return fmt.Errorf("ext4sdk juicefs backend: read out of bounds")
	}
	offset := int64(blockID) * int64(b.blockSize)
	if _, err := b.file.Seek(b.ctx, offset, io.SeekStart); err != nil {
		return err
	}
	buf := dst
	for len(buf) > 0 {
		n, err := b.file.Read(b.ctx, buf)
		if n > 0 {
			buf = buf[n:]
		}
		if err == nil {
			continue
		}
		if err == io.EOF && len(buf) == 0 {
			return nil
		}
		if err == io.EOF {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	return nil
}

func (b *JuiceFSFileBackend) WriteBlocks(blockID uint64, src []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(src)%int(b.blockSize) != 0 {
		return fmt.Errorf("ext4sdk juicefs backend: misaligned write size %d", len(src))
	}
	if err := b.ensureFileLocked(); err != nil {
		return err
	}
	blockCount := uint64(len(src) / int(b.blockSize))
	if blockID+blockCount > b.blockCount {
		return fmt.Errorf("ext4sdk juicefs backend: write out of bounds")
	}
	offset := int64(blockID) * int64(b.blockSize)
	if _, err := b.file.Seek(b.ctx, offset, io.SeekStart); err != nil {
		return err
	}
	buf := src
	for len(buf) > 0 {
		n, err := b.file.Write(b.ctx, buf)
		if n > 0 {
			buf = buf[n:]
		}
		if err != 0 {
			return err
		}
	}
	return nil
}

func (b *JuiceFSFileBackend) Sync() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.ensureFileLocked(); err != nil {
		return err
	}
	if errno := b.file.Fsync(b.ctx); errno != 0 {
		return errno
	}
	return nil
}

func (b *JuiceFSFileBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closeLocked()
}

func (b *JuiceFSFileBackend) closeLocked() error {
	if b.file == nil {
		return nil
	}
	err := b.file.Close(b.ctx)
	b.file = nil
	if err != 0 {
		return err
	}
	return nil
}

func (b *JuiceFSFileBackend) ensureFileLocked() error {
	if b.file != nil {
		return nil
	}
	wantSize := uint64(b.blockSize) * b.blockCount
	if err := b.ensureRegularFileLocked(); err != nil {
		return err
	}
	f, eno := b.jfs.Open(b.ctx, b.path, meta.MODE_MASK_R|meta.MODE_MASK_W)
	if eno != 0 {
		return eno
	}
	if errno := f.Truncate(b.ctx, wantSize); errno != 0 {
		_ = f.Close(b.ctx)
		return errno
	}
	b.file = f
	return nil
}

func (b *JuiceFSFileBackend) ensureRegularFileLocked() error {
	if st, eno := b.jfs.Stat(b.ctx, b.path); eno == 0 {
		if st.IsDir() {
			return fmt.Errorf("ext4sdk juicefs backend: %s is a directory", b.path)
		}
		return nil
	} else if eno != syscall.ENOENT {
		return eno
	}
	dir := path.Dir(b.path)
	if dir != "/" && dir != "." {
		if eno := b.jfs.MkdirAll(b.ctx, dir, 0o755, 0); eno != 0 {
			return eno
		}
	}
	f, eno := b.jfs.Create(b.ctx, b.path, 0o644, 0)
	if eno != 0 {
		return eno
	}
	return f.Close(b.ctx)
}
