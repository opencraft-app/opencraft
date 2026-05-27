//go:build !linux || !cgo || !lwext4sdk

package ext4sdk

type FS struct{}

func New(BlockBackend, Options) (*FS, error) { return nil, ErrUnavailable }
func (fs *FS) Format(FormatOptions) error    { return ErrUnavailable }
func (fs *FS) Mount(bool) error              { return ErrUnavailable }
func (fs *FS) Recover() error                { return ErrUnavailable }
func (fs *FS) SetWriteBack(bool) error       { return ErrUnavailable }
func (fs *FS) Flush() error                  { return ErrUnavailable }
func (fs *FS) Unmount() error                { return ErrUnavailable }
func (fs *FS) Close() error                  { return nil }
func (fs *FS) OpenFile(string, string) (*FileHandle, error) {
	return nil, ErrUnavailable
}
func (fs *FS) Mkdir(string) error             { return ErrUnavailable }
func (fs *FS) Remove(string) error            { return ErrUnavailable }
func (fs *FS) Rename(string, string) error    { return ErrUnavailable }
func (fs *FS) OpenDir(string) (*DirHandle, error) {
	return nil, ErrUnavailable
}
func (fs *FS) Stats() (*MountStats, error) { return nil, ErrUnavailable }

type FileHandle struct{}
type DirHandle struct{}

func (f *FileHandle) Read([]byte) (int, error)       { return 0, ErrUnavailable }
func (f *FileHandle) Write([]byte) (int, error)      { return 0, ErrUnavailable }
func (f *FileHandle) Seek(int64, int) (int64, error) { return 0, ErrUnavailable }
func (f *FileHandle) Size() uint64                   { return 0 }
func (f *FileHandle) Close() error                   { return nil }
func (f *FileHandle) Truncate(uint64) error          { return ErrUnavailable }
func (d *DirHandle) Next() (*DirEntry, error)        { return nil, ErrUnavailable }
func (d *DirHandle) Close() error                    { return nil }
