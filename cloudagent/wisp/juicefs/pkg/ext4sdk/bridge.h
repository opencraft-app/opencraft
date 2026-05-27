#pragma once

#include <stdint.h>
#include <ext4.h>
#include <ext4_mkfs.h>
#include <ext4_bcache.h>

struct jfs_ext4_blockdev {
	struct ext4_blockdev dev;
	struct ext4_blockdev_iface iface;
	struct ext4_bcache bc;
};

static struct jfs_ext4_blockdev *jfs_ext4_blockdev_create(uintptr_t handle, uint32_t block_size, uint64_t block_count, uint32_t cache_items);
static void jfs_ext4_blockdev_destroy(struct jfs_ext4_blockdev *bdev);
static const ext4_direntry *jfs_ext4_dir_next(ext4_dir *dir);

int jfsExt4BackendOpen(uintptr_t handle);
int jfsExt4BackendRead(uintptr_t handle, uint64_t block_id, void *buf, uint32_t block_count, uint32_t block_size);
int jfsExt4BackendWrite(uintptr_t handle, uint64_t block_id, void *buf, uint32_t block_count, uint32_t block_size);
int jfsExt4BackendClose(uintptr_t handle);
int jfsExt4BackendLock(uintptr_t handle);
int jfsExt4BackendUnlock(uintptr_t handle);
