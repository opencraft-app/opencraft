//go:build linux && cgo && lwext4sdk

package ext4sdk

/*
#cgo CFLAGS: -I${SRCDIR}/../../third_party/lwext4/build_lib_only/include
#cgo CFLAGS: -I${SRCDIR}/../../third_party/lwext4/build_lib_only/include/generated
#cgo CFLAGS: -I${SRCDIR}/../../third_party/lwext4/include
#cgo LDFLAGS: ${SRCDIR}/../../third_party/lwext4/build_lib_only/src/liblwext4.a
#include <stdlib.h>
#include "bridge.h"

static int jfs_bdev_open(struct ext4_blockdev *bdev) {
	return jfsExt4BackendOpen((uintptr_t)bdev->bdif->p_user);
}

static int jfs_bdev_bread(struct ext4_blockdev *bdev, void *buf, uint64_t blk_id, uint32_t blk_cnt) {
	return jfsExt4BackendRead((uintptr_t)bdev->bdif->p_user, blk_id, buf, blk_cnt, bdev->bdif->ph_bsize);
}

static int jfs_bdev_bwrite(struct ext4_blockdev *bdev, const void *buf, uint64_t blk_id, uint32_t blk_cnt) {
	return jfsExt4BackendWrite((uintptr_t)bdev->bdif->p_user, blk_id, (void *)buf, blk_cnt, bdev->bdif->ph_bsize);
}

static int jfs_bdev_close(struct ext4_blockdev *bdev) {
	return jfsExt4BackendClose((uintptr_t)bdev->bdif->p_user);
}

static int jfs_bdev_lock(struct ext4_blockdev *bdev) {
	return jfsExt4BackendLock((uintptr_t)bdev->bdif->p_user);
}

static int jfs_bdev_unlock(struct ext4_blockdev *bdev) {
	return jfsExt4BackendUnlock((uintptr_t)bdev->bdif->p_user);
}

static struct jfs_ext4_blockdev *jfs_ext4_blockdev_create(uintptr_t handle, uint32_t block_size, uint64_t block_count, uint32_t cache_items) {
	struct jfs_ext4_blockdev *b = calloc(1, sizeof(*b));
	if (!b) {
		return NULL;
	}

	b->iface.open = jfs_bdev_open;
	b->iface.bread = jfs_bdev_bread;
	b->iface.bwrite = jfs_bdev_bwrite;
	b->iface.close = jfs_bdev_close;
	b->iface.lock = jfs_bdev_lock;
	b->iface.unlock = jfs_bdev_unlock;
	b->iface.ph_bsize = block_size;
	b->iface.ph_bcnt = block_count;
	b->iface.ph_bbuf = malloc(block_size);
	b->iface.p_user = (void *)handle;

	if (!b->iface.ph_bbuf) {
		free(b);
		return NULL;
	}

	b->dev.bdif = &b->iface;
	b->dev.part_offset = 0;
	b->dev.part_size = ((uint64_t)block_size) * block_count;

	if (ext4_bcache_init_dynamic(&b->bc, cache_items, block_size) != EOK) {
		free(b->iface.ph_bbuf);
		free(b);
		return NULL;
	}

	if (ext4_block_bind_bcache(&b->dev, &b->bc) != EOK) {
		ext4_bcache_fini_dynamic(&b->bc);
		free(b->iface.ph_bbuf);
		free(b);
		return NULL;
	}

	return b;
}

static void jfs_ext4_blockdev_destroy(struct jfs_ext4_blockdev *bdev) {
	if (!bdev) {
		return;
	}
	ext4_bcache_fini_dynamic(&bdev->bc);
	free(bdev->iface.ph_bbuf);
	free(bdev);
}

static const ext4_direntry *jfs_ext4_dir_next(ext4_dir *dir) {
	return ext4_dir_entry_next(dir);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"io"
	"path"
	"runtime"
	gocgo "runtime/cgo"
	"strconv"
	"strings"
	"sync"
	"unsafe"
)

const (
	defaultCacheItems = 128
)

type FS struct {
	mu         sync.Mutex
	backendMu  sync.Mutex
	backend    BlockBackend
	handle     gocgo.Handle
	deviceName string
	mountPoint string
	bdev       *C.struct_jfs_ext4_blockdev
	mounted    bool
	closed     bool
}

type FileHandle struct {
	fs   *FS
	file C.ext4_file
	open bool
}

type DirHandle struct {
	fs   *FS
	dir  C.ext4_dir
	open bool
}

func New(backend BlockBackend, opts Options) (*FS, error) {
	if backend == nil {
		return nil, errors.New("ext4sdk: nil backend")
	}
	if backend.BlockSize() == 0 || backend.BlockCount() == 0 {
		return nil, errors.New("ext4sdk: invalid backend geometry")
	}

	deviceName := opts.DeviceName
	if deviceName == "" {
		deviceName = "juicefs-ext4-" + strconv.FormatUint(uint64(uintptr(unsafe.Pointer(&backend))), 16)
	}
	mountPoint := cleanMountPoint(opts.MountPoint)
	cacheItems := opts.CacheItems
	if cacheItems == 0 {
		cacheItems = defaultCacheItems
	}

	fs := &FS{
		backend:    backend,
		deviceName: deviceName,
		mountPoint: mountPoint,
	}
	fs.handle = gocgo.NewHandle(fs)
	fs.bdev = C.jfs_ext4_blockdev_create(
		C.uintptr_t(fs.handle),
		C.uint(backend.BlockSize()),
		C.uint64_t(backend.BlockCount()),
		C.uint(cacheItems),
	)
	if fs.bdev == nil {
		fs.handle.Delete()
		return nil, errors.New("ext4sdk: create block device")
	}

	cdev := C.CString(fs.deviceName)
	defer C.free(unsafe.Pointer(cdev))
	if rc := C.ext4_device_register(&fs.bdev.dev, cdev); rc != 0 {
		C.jfs_ext4_blockdev_destroy(fs.bdev)
		fs.handle.Delete()
		return nil, ext4Error("device_register", int(rc))
	}

	runtime.SetFinalizer(fs, (*FS).finalize)
	return fs, nil
}

func (fs *FS) Format(opts FormatOptions) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureOpenLocked(); err != nil {
		return err
	}
	if fs.mounted {
		return errors.New("ext4sdk: cannot format mounted filesystem")
	}

	label := C.CString(opts.Label)
	defer C.free(unsafe.Pointer(label))

	var info C.struct_ext4_mkfs_info
	info.len = C.uint64_t(opts.Length)
	info.block_size = C.uint(opts.BlockSize)
	if opts.Journal {
		info.journal = true
	}
	info.label = label

	var extfs C.struct_ext4_fs
	if rc := C.ext4_mkfs(&extfs, &fs.bdev.dev, &info, C.int(normalizeFSType(opts.Type))); rc != 0 {
		return ext4Error("mkfs", int(rc))
	}
	return nil
}

func (fs *FS) Mount(readOnly bool) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureOpenLocked(); err != nil {
		return err
	}
	if fs.mounted {
		return nil
	}

	cdev := C.CString(fs.deviceName)
	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cdev))
	defer C.free(unsafe.Pointer(cmp))

	if rc := C.ext4_mount(cdev, cmp, C.bool(readOnly)); rc != 0 {
		return ext4Error("mount", int(rc))
	}
	if fs.backend != nil && !readOnly {
		_ = C.ext4_cache_write_back(cmp, true)
	}
	fs.mounted = true
	return nil
}

func (fs *FS) Recover() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cmp))
	if rc := C.ext4_recover(cmp); rc != 0 {
		return ext4Error("recover", int(rc))
	}
	return nil
}

func (fs *FS) SetWriteBack(on bool) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cmp))
	if rc := C.ext4_cache_write_back(cmp, C.bool(on)); rc != 0 {
		return ext4Error("cache_write_back", int(rc))
	}
	return nil
}

func (fs *FS) Flush() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cmp))
	if rc := C.ext4_cache_flush(cmp); rc != 0 {
		return ext4Error("cache_flush", int(rc))
	}
	return nil
}

func (fs *FS) Unmount() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if fs.closed {
		return ErrClosed
	}
	if !fs.mounted {
		return nil
	}

	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cmp))
	_ = C.ext4_cache_write_back(cmp, false)
	if rc := C.ext4_umount(cmp); rc != 0 {
		return ext4Error("umount", int(rc))
	}
	fs.mounted = false
	return nil
}

func (fs *FS) Close() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.closeLocked()
}

func (fs *FS) finalize() {
	_ = fs.Close()
}

func (fs *FS) OpenFile(name, flags string) (*FileHandle, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return nil, err
	}

	full := C.CString(fs.fullPath(name))
	cflags := C.CString(flags)
	defer C.free(unsafe.Pointer(full))
	defer C.free(unsafe.Pointer(cflags))

	fh := &FileHandle{fs: fs, open: true}
	if rc := C.ext4_fopen(&fh.file, full, cflags); rc != 0 {
		return nil, ext4Error("fopen", int(rc))
	}
	return fh, nil
}

func (fs *FS) Mkdir(name string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	full := C.CString(fs.fullPath(name))
	defer C.free(unsafe.Pointer(full))
	if rc := C.ext4_dir_mk(full); rc != 0 {
		return ext4Error("dir_mk", int(rc))
	}
	return nil
}

func (fs *FS) Remove(name string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	full := C.CString(fs.fullPath(name))
	defer C.free(unsafe.Pointer(full))
	if rc := C.ext4_fremove(full); rc != 0 {
		return ext4Error("fremove", int(rc))
	}
	return nil
}

func (fs *FS) Rename(oldName, newName string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return err
	}
	oldPath := C.CString(fs.fullPath(oldName))
	newPath := C.CString(fs.fullPath(newName))
	defer C.free(unsafe.Pointer(oldPath))
	defer C.free(unsafe.Pointer(newPath))
	if rc := C.ext4_frename(oldPath, newPath); rc != 0 {
		return ext4Error("frename", int(rc))
	}
	return nil
}

func (fs *FS) OpenDir(name string) (*DirHandle, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return nil, err
	}
	full := C.CString(fs.fullPath(name))
	defer C.free(unsafe.Pointer(full))

	dh := &DirHandle{fs: fs, open: true}
	if rc := C.ext4_dir_open(&dh.dir, full); rc != 0 {
		return nil, ext4Error("dir_open", int(rc))
	}
	return dh, nil
}

func (fs *FS) Stats() (*MountStats, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.ensureMountedLocked(); err != nil {
		return nil, err
	}
	cmp := C.CString(fs.mountPoint)
	defer C.free(unsafe.Pointer(cmp))
	var stats C.struct_ext4_mount_stats
	if rc := C.ext4_mount_point_stats(cmp, &stats); rc != 0 {
		return nil, ext4Error("mount_point_stats", int(rc))
	}
	return &MountStats{
		InodesCount:     uint32(stats.inodes_count),
		FreeInodesCount: uint32(stats.free_inodes_count),
		BlocksCount:     uint64(stats.blocks_count),
		FreeBlocksCount: uint64(stats.free_blocks_count),
		BlockSize:       uint32(stats.block_size),
		BlockGroupCount: uint32(stats.block_group_count),
		BlocksPerGroup:  uint32(stats.blocks_per_group),
		InodesPerGroup:  uint32(stats.inodes_per_group),
		VolumeName:      C.GoString(&stats.volume_name[0]),
	}, nil
}

func (fs *FS) closeLocked() error {
	if fs.closed {
		return nil
	}
	var firstErr error
	if fs.mounted {
		cmp := C.CString(fs.mountPoint)
		_ = C.ext4_cache_write_back(cmp, false)
		if rc := C.ext4_umount(cmp); rc != 0 && firstErr == nil {
			firstErr = ext4Error("umount", int(rc))
		}
		C.free(unsafe.Pointer(cmp))
		fs.mounted = false
	}
	cdev := C.CString(fs.deviceName)
	if rc := C.ext4_device_unregister(cdev); rc != 0 && firstErr == nil {
		firstErr = ext4Error("device_unregister", int(rc))
	}
	C.free(unsafe.Pointer(cdev))
	if fs.bdev != nil {
		C.jfs_ext4_blockdev_destroy(fs.bdev)
		fs.bdev = nil
	}
	if fs.backend != nil {
		if err := fs.backend.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	fs.handle.Delete()
	fs.closed = true
	return firstErr
}

func (fs *FS) ensureOpenLocked() error {
	if fs.closed {
		return ErrClosed
	}
	return nil
}

func (fs *FS) ensureMountedLocked() error {
	if err := fs.ensureOpenLocked(); err != nil {
		return err
	}
	if !fs.mounted {
		return errors.New("ext4sdk: not mounted")
	}
	return nil
}

func (fs *FS) fullPath(name string) string {
	name = "/" + strings.TrimPrefix(path.Clean("/"+name), "/")
	if strings.HasSuffix(fs.mountPoint, "/") {
		return strings.TrimSuffix(fs.mountPoint, "/") + name
	}
	return fs.mountPoint + name
}

func cleanMountPoint(mp string) string {
	if mp == "" {
		return "/jfs-ext4/"
	}
	if !strings.HasPrefix(mp, "/") {
		mp = "/" + mp
	}
	if !strings.HasSuffix(mp, "/") {
		mp += "/"
	}
	return mp
}

func normalizeFSType(t FilesystemType) FilesystemType {
	switch t {
	case Ext2, Ext3, Ext4:
		return t
	default:
		return Ext4
	}
}

func (f *FileHandle) Read(p []byte) (int, error) {
	if !f.open {
		return 0, ErrClosed
	}
	if len(p) == 0 {
		return 0, nil
	}
	var n C.size_t
	if rc := C.ext4_fread(&f.file, unsafe.Pointer(&p[0]), C.size_t(len(p)), &n); rc != 0 {
		return int(n), ext4Error("fread", int(rc))
	}
	if int(n) == 0 {
		return 0, io.EOF
	}
	return int(n), nil
}

func (f *FileHandle) Write(p []byte) (int, error) {
	if !f.open {
		return 0, ErrClosed
	}
	if len(p) == 0 {
		return 0, nil
	}
	var n C.size_t
	if rc := C.ext4_fwrite(&f.file, unsafe.Pointer(&p[0]), C.size_t(len(p)), &n); rc != 0 {
		return int(n), ext4Error("fwrite", int(rc))
	}
	return int(n), nil
}

func (f *FileHandle) Seek(offset int64, whence int) (int64, error) {
	if !f.open {
		return 0, ErrClosed
	}
	if rc := C.ext4_fseek(&f.file, C.int64_t(offset), C.uint(whence)); rc != 0 {
		return 0, ext4Error("fseek", int(rc))
	}
	return int64(C.ext4_ftell(&f.file)), nil
}

func (f *FileHandle) Size() uint64 {
	return uint64(C.ext4_fsize(&f.file))
}

func (f *FileHandle) Truncate(size uint64) error {
	if !f.open {
		return ErrClosed
	}
	if rc := C.ext4_ftruncate(&f.file, C.uint64_t(size)); rc != 0 {
		return ext4Error("ftruncate", int(rc))
	}
	return nil
}

func (f *FileHandle) Close() error {
	if !f.open {
		return nil
	}
	if rc := C.ext4_fclose(&f.file); rc != 0 {
		return ext4Error("fclose", int(rc))
	}
	f.open = false
	return nil
}

func (d *DirHandle) Next() (*DirEntry, error) {
	if !d.open {
		return nil, ErrClosed
	}
	entry := C.jfs_ext4_dir_next(&d.dir)
	if entry == nil {
		return nil, io.EOF
	}
	return &DirEntry{
		Inode: uint32(entry.inode),
		Type:  uint8(entry.inode_type),
		Name:  C.GoStringN((*C.char)(unsafe.Pointer(&entry.name[0])), C.int(entry.name_length)),
	}, nil
}

func (d *DirHandle) Close() error {
	if !d.open {
		return nil
	}
	if rc := C.ext4_dir_close(&d.dir); rc != 0 {
		return ext4Error("dir_close", int(rc))
	}
	d.open = false
	return nil
}

func ext4Error(op string, rc int) error {
	return fmt.Errorf("ext4sdk %s: rc=%d", op, rc)
}

//export jfsExt4BackendOpen
func jfsExt4BackendOpen(handle C.uintptr_t) C.int {
	if _, err := fsFromHandle(handle); err != nil {
		return -1
	}
	return 0
}

//export jfsExt4BackendRead
func jfsExt4BackendRead(handle C.uintptr_t, blockID C.uint64_t, buf unsafe.Pointer, blockCount C.uint32_t, blockSize C.uint32_t) C.int {
	fs, err := fsFromHandle(handle)
	if err != nil {
		return -1
	}
	n := int(blockCount) * int(blockSize)
	dst := unsafe.Slice((*byte)(buf), n)
	if err := fs.backend.ReadBlocks(uint64(blockID), dst); err != nil {
		return -1
	}
	return 0
}

//export jfsExt4BackendWrite
func jfsExt4BackendWrite(handle C.uintptr_t, blockID C.uint64_t, buf unsafe.Pointer, blockCount C.uint32_t, blockSize C.uint32_t) C.int {
	fs, err := fsFromHandle(handle)
	if err != nil {
		return -1
	}
	n := int(blockCount) * int(blockSize)
	src := unsafe.Slice((*byte)(buf), n)
	if err := fs.backend.WriteBlocks(uint64(blockID), src); err != nil {
		return -1
	}
	return 0
}

//export jfsExt4BackendClose
func jfsExt4BackendClose(handle C.uintptr_t) C.int {
	fs, err := fsFromHandle(handle)
	if err != nil {
		return -1
	}
	if err := fs.backend.Sync(); err != nil {
		return -1
	}
	return 0
}

//export jfsExt4BackendLock
func jfsExt4BackendLock(handle C.uintptr_t) C.int {
	fs, err := fsFromHandle(handle)
	if err != nil {
		return -1
	}
	fs.backendMu.Lock()
	return 0
}

//export jfsExt4BackendUnlock
func jfsExt4BackendUnlock(handle C.uintptr_t) C.int {
	fs, err := fsFromHandle(handle)
	if err != nil {
		return -1
	}
	fs.backendMu.Unlock()
	return 0
}

func fsFromHandle(handle C.uintptr_t) (*FS, error) {
	h := gocgo.Handle(handle)
	v := h.Value()
	fs, ok := v.(*FS)
	if !ok || fs == nil {
		return nil, errors.New("ext4sdk: invalid handle")
	}
	return fs, nil
}
