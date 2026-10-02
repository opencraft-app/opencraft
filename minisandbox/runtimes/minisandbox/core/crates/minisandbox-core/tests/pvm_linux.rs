//! Linux direct-boot image construction tests.

use minisandbox_core::pvm_linux::{PvmLinuxImage, PvmLinuxImageError};

const MEMORY_SIZE: usize = 16 * 1024 * 1024;

fn synthetic_bzimage() -> Vec<u8> {
    let mut kernel = vec![0; 8192];
    kernel[0] = 0xa5;
    kernel[0x1f1] = 4;
    kernel[0x200] = 0xeb;
    kernel[0x201] = 0x6a;
    kernel[0x202..0x206].copy_from_slice(b"HdrS");
    kernel[0x206..0x208].copy_from_slice(&0x020c_u16.to_le_bytes());
    kernel[0x211] = 1;
    kernel[0x214..0x218].copy_from_slice(&0x10_0000_u32.to_le_bytes());
    kernel[0x22c..0x230].copy_from_slice(&0x03ff_ffff_u32.to_le_bytes());
    kernel[0x236..0x238].copy_from_slice(&1_u16.to_le_bytes());
    kernel[0x238..0x23c].copy_from_slice(&2048_u32.to_le_bytes());
    kernel[0x258..0x260].copy_from_slice(&0x40_0000_u64.to_le_bytes());
    kernel[0x260..0x264].copy_from_slice(&0x20_0000_u32.to_le_bytes());
    for (index, byte) in kernel[2560..].iter_mut().enumerate() {
        *byte = index.to_le_bytes()[0];
    }
    kernel
}

#[test]
fn constructs_standard_linux_64_bit_boot_state() {
    let kernel = synthetic_bzimage();
    let initramfs = b"070701 synthetic cpio";
    let image =
        PvmLinuxImage::from_bzimage(&kernel, initramfs, b"console=ttyS0 panic=-1", MEMORY_SIZE)
            .expect("valid image");

    assert_eq!(image.memory_size(), MEMORY_SIZE);
    assert!(image.boot_memory().len() < MEMORY_SIZE / 2);
    assert_eq!(image.boot_config().entry_rip, 0x40_0200);
    assert_eq!(image.boot_config().boot_params_gpa, 0x7000);
    assert_eq!(image.boot_config().bootstrap_cr3, 0x9000);
    assert_eq!(image.boot_config().gdt_limit, 31);
    assert_eq!(
        image.boot_memory()[0x40_0000..0x40_0008],
        kernel[2560..2568]
    );
    assert_eq!(image.boot_memory()[0x7000], 0);
    assert_eq!(image.boot_memory()[0x7000 + 0x200], 0xeb);
    assert_eq!(
        u32::from_le_bytes(
            image.boot_memory()[0x7000 + 0x214..0x7000 + 0x218]
                .try_into()
                .unwrap()
        ),
        0x40_0000
    );
    assert_eq!(image.boot_memory()[0x7000 + 0x1e8], 2);
    assert_eq!(
        u64::from_le_bytes(image.boot_memory()[0x9000..0x9008].try_into().unwrap()),
        0xa003
    );
    assert_eq!(
        u64::from_le_bytes(image.boot_memory()[0x510..0x518].try_into().unwrap()),
        0x00af_9a00_0000_ffff
    );
    let initramfs_range = image.initramfs_range();
    assert_eq!(
        initramfs_range.end - initramfs_range.start,
        initramfs.len() as u64
    );
    assert_eq!(image.initramfs(), initramfs);
}

#[test]
fn rejects_non_linux_and_undersized_layouts() {
    assert_eq!(
        PvmLinuxImage::from_bzimage(&[0; 4096], &[], b"", MEMORY_SIZE),
        Err(PvmLinuxImageError::InvalidKernel)
    );
    assert_eq!(
        PvmLinuxImage::from_bzimage(&synthetic_bzimage(), &[], b"", 4096),
        Err(PvmLinuxImageError::InvalidMemoryLayout)
    );
}

#[test]
fn rejects_embedded_nul_in_command_line() {
    assert_eq!(
        PvmLinuxImage::from_bzimage(&synthetic_bzimage(), &[], b"a\0b", MEMORY_SIZE),
        Err(PvmLinuxImageError::InvalidCommandLine)
    );
}
