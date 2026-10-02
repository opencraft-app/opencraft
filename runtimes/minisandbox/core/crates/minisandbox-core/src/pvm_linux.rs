//! PVM-aware Linux `bzImage` direct-boot image construction.

use std::{error::Error, fmt};

use minisandbox_pvm_sys::PvmLinuxBootConfig;

const BOOT_PARAMS: usize = 0x7000;
const BOOT_STACK: usize = 0x9000;
const BOOT_PML4: usize = 0x9000;
const BOOT_PDPT: usize = 0xa000;
const BOOT_PD_START: usize = 0xb000;
const BOOT_PD_COUNT: usize = 4;
const BOOT_GDT: usize = 0x500;
const BOOT_CMDLINE: usize = 0x2_0000;
const MIN_MEMORY_SIZE: usize = 16 * 1024 * 1024;
/// Maximum contiguous RAM accepted by the audited PVM Linux physical layout.
pub const MAX_PVM_LINUX_MEMORY_SIZE: usize = 3 * 1024 * 1024 * 1024;
const SETUP_HEADER_START: usize = 0x1f1;
const SETUP_HEADER_MINIMUM: usize = 0x268;
const SETUP_HEADER_LIMIT: usize = 0x290;
const E820_ENTRIES: usize = 0x1e8;
const E820_TABLE: usize = 0x2d0;
const E820_ENTRY_SIZE: usize = 20;
const E820_RAM: u32 = 1;
const HDR_MAGIC: &[u8; 4] = b"HdrS";
const XLF_KERNEL_64: u16 = 1;
const LOAD_HIGH: u8 = 1;

/// GPA base for the read-only PMEM root image.
///
/// Linux RAM is capped at 3 GiB by this loader, and the clone-private stream
/// mailbox occupies the first 512 KiB at 4 GiB. Starting immutable images at
/// 8 GiB leaves a fixed audited hole for devices while allowing large agents to
/// select a 1--3 GiB RAM quota without another per-profile physical layout.
pub const READ_ONLY_ROOTFS_GPA: u64 = 0x2_0000_0000;

/// GPA base for the optional read-only application EROFS layer.
///
/// Keeping it at 16 GiB makes `/dev/pmem0` the base root and `/dev/pmem1` the
/// higher-precedence application tree while leaving an 8 GiB checked window
/// for the base image. KVM slot assignment is independent: this range uses
/// the second audited immutable slot rather than the socket-service slots.
pub const READ_ONLY_APP_GPA: u64 = 0x4_0000_0000;

/// Sparse boot artifacts for one zero-initialized Linux guest-RAM mapping.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PvmLinuxImage {
    memory_size: usize,
    boot_memory: Vec<u8>,
    initramfs: Vec<u8>,
    boot: PvmLinuxBootConfig,
    kernel_range: std::ops::Range<u64>,
    initramfs_range: std::ops::Range<u64>,
}

/// Rejected Linux boot image or guest-physical layout.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PvmLinuxImageError {
    /// The input is not a supported x86 Linux `bzImage`.
    InvalidKernel,
    /// The kernel does not advertise the `x86_64` boot protocol.
    UnsupportedProtocol,
    /// The command line contains NUL or exceeds the kernel's advertised limit.
    InvalidCommandLine,
    /// Guest memory is unaligned, too small, or cannot hold all boot artifacts.
    InvalidMemoryLayout,
}

impl fmt::Display for PvmLinuxImageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKernel => formatter.write_str("invalid x86 Linux bzImage"),
            Self::UnsupportedProtocol => {
                formatter.write_str("kernel does not support x86_64 direct boot")
            }
            Self::InvalidCommandLine => formatter.write_str("invalid Linux kernel command line"),
            Self::InvalidMemoryLayout => {
                formatter.write_str("Linux boot artifacts do not fit guest memory")
            }
        }
    }
}

impl Error for PvmLinuxImageError {}

impl PvmLinuxImage {
    /// Constructs the Linux zero page, identity page tables, GDT, kernel, and
    /// optional initramfs as sparse writes into zero-initialized guest RAM.
    ///
    /// # Errors
    ///
    /// Returns [`PvmLinuxImageError`] when the image lacks the required Linux
    /// boot header or any checked guest-physical range is invalid.
    pub fn from_bzimage(
        kernel: &[u8],
        initramfs: &[u8],
        command_line: &[u8],
        memory_size: usize,
    ) -> Result<Self, PvmLinuxImageError> {
        validate_memory_size(memory_size)?;
        let header = BzImageHeader::parse(kernel)?;
        if command_line.contains(&0)
            || command_line
                .len()
                .checked_add(1)
                .is_none_or(|size| size > header.command_line_size)
        {
            return Err(PvmLinuxImageError::InvalidCommandLine);
        }

        // Protocol 2.10 added `pref_address` specifically so relocating
        // loaders can reserve the complete `init_size` working range at the
        // kernel's runtime base.  Loading this PVM kernel at the legacy 1 MiB
        // `code32_start` makes the decompressor choose its 16 MiB runtime base
        // outside the range it carries into its replacement identity map.
        let kernel_start = usize::try_from(header.load_address())
            .map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?;
        let kernel_payload = &kernel[header.payload_offset..];
        let kernel_file_end = checked_end(kernel_start, kernel_payload.len(), memory_size)?;
        let kernel_reserved_end = checked_end(
            kernel_start,
            kernel_payload.len().max(header.init_size),
            memory_size,
        )?;
        if kernel_start < 0x10_0000 || kernel_payload.len() <= 0x200 {
            return Err(PvmLinuxImageError::InvalidMemoryLayout);
        }

        let command_end = checked_end(BOOT_CMDLINE, command_line.len() + 1, memory_size)?;
        if command_end > kernel_start {
            return Err(PvmLinuxImageError::InvalidMemoryLayout);
        }

        let initramfs_start = place_initramfs(
            initramfs.len(),
            memory_size,
            header.initrd_address_max,
            kernel_reserved_end,
        )?;
        let initramfs_end = checked_end(initramfs_start, initramfs.len(), memory_size)?;

        let boot_memory_size = align_up(
            kernel_file_end
                .max(command_end)
                .max(BOOT_PARAMS + 4096)
                .max(BOOT_PD_START + BOOT_PD_COUNT * 4096)
                .max(BOOT_GDT + 4 * 8),
            4096,
        )
        .ok_or(PvmLinuxImageError::InvalidMemoryLayout)?;
        let mut boot_memory = vec![0; boot_memory_size];
        boot_memory[BOOT_PARAMS + SETUP_HEADER_START..BOOT_PARAMS + header.setup_header_end]
            .copy_from_slice(&kernel[SETUP_HEADER_START..header.setup_header_end]);
        boot_memory[kernel_start..kernel_file_end].copy_from_slice(kernel_payload);
        boot_memory[BOOT_CMDLINE..BOOT_CMDLINE + command_line.len()].copy_from_slice(command_line);

        install_boot_params(
            &mut boot_memory,
            memory_size,
            command_line,
            kernel_start,
            initramfs_start,
            initramfs.len(),
        )?;
        install_bootstrap_page_tables(&mut boot_memory);
        install_bootstrap_gdt(&mut boot_memory);

        Ok(Self {
            memory_size,
            boot_memory,
            initramfs: initramfs.to_vec(),
            boot: PvmLinuxBootConfig {
                entry_rip: u64::try_from(kernel_start + 0x200)
                    .map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?,
                boot_params_gpa: BOOT_PARAMS as u64,
                bootstrap_cr3: BOOT_PML4 as u64,
                stack_pointer: BOOT_STACK as u64,
                gdt_base: BOOT_GDT as u64,
                gdt_limit: 4 * 8 - 1,
            },
            kernel_range: (kernel_start as u64)..(kernel_file_end as u64),
            initramfs_range: (initramfs_start as u64)..(initramfs_end as u64),
        })
    }

    /// Returns the size of the zero-initialized guest-RAM mapping.
    #[must_use]
    pub const fn memory_size(&self) -> usize {
        self.memory_size
    }

    /// Borrows the populated low-memory prefix containing boot state and kernel.
    #[must_use]
    pub fn boot_memory(&self) -> &[u8] {
        &self.boot_memory
    }

    /// Borrows the optional initramfs written at [`Self::initramfs_range`].
    #[must_use]
    pub fn initramfs(&self) -> &[u8] {
        &self.initramfs
    }

    /// Returns the Linux entry-register contract for this image.
    #[must_use]
    pub const fn boot_config(&self) -> PvmLinuxBootConfig {
        self.boot
    }

    /// Returns the installed protected-mode kernel byte range.
    #[must_use]
    pub fn kernel_range(&self) -> std::ops::Range<u64> {
        self.kernel_range.clone()
    }

    /// Returns the installed initramfs range, empty when none was supplied.
    #[must_use]
    pub fn initramfs_range(&self) -> std::ops::Range<u64> {
        self.initramfs_range.clone()
    }
}

struct BzImageHeader {
    payload_offset: usize,
    code32_start: u32,
    pref_address: u64,
    init_size: usize,
    initrd_address_max: u32,
    command_line_size: usize,
    setup_header_end: usize,
}

impl BzImageHeader {
    fn parse(kernel: &[u8]) -> Result<Self, PvmLinuxImageError> {
        if kernel.len() < SETUP_HEADER_MINIMUM || kernel.get(0x202..0x206) != Some(HDR_MAGIC) {
            return Err(PvmLinuxImageError::InvalidKernel);
        }
        let version = read_u16(kernel, 0x206)?;
        let xloadflags = read_u16(kernel, 0x236)?;
        if version < 0x20c || xloadflags & XLF_KERNEL_64 == 0 || kernel[0x211] & LOAD_HIGH == 0 {
            return Err(PvmLinuxImageError::UnsupportedProtocol);
        }
        // The short jump at 0x200 doubles as the setup_header length.  A
        // protected-mode loader must copy only this header into an otherwise
        // zeroed boot_params page; copying the real-mode setup blob corrupts
        // screen_info, APM, EFI, and EDD inputs.
        if kernel[0x200] != 0xeb {
            return Err(PvmLinuxImageError::InvalidKernel);
        }
        let setup_header_end = 0x202 + usize::from(kernel[0x201]);
        if !(SETUP_HEADER_MINIMUM..=SETUP_HEADER_LIMIT).contains(&setup_header_end)
            || setup_header_end > kernel.len()
        {
            return Err(PvmLinuxImageError::InvalidKernel);
        }
        let setup_sectors = match kernel[0x1f1] {
            0 => 4,
            sectors => usize::from(sectors),
        };
        let payload_offset = setup_sectors
            .checked_add(1)
            .and_then(|sectors| sectors.checked_mul(512))
            .ok_or(PvmLinuxImageError::InvalidKernel)?;
        if payload_offset >= kernel.len() {
            return Err(PvmLinuxImageError::InvalidKernel);
        }
        let code32_start = read_u32(kernel, 0x214)?;
        let pref_address = read_u64(kernel, 0x258)?;
        let init_size = usize::try_from(read_u32(kernel, 0x260)?)
            .map_err(|_| PvmLinuxImageError::InvalidKernel)?;
        let initrd_address_max = read_u32(kernel, 0x22c)?;
        let command_line_size = usize::try_from(read_u32(kernel, 0x238)?)
            .map_err(|_| PvmLinuxImageError::InvalidKernel)?;
        if code32_start == 0 || init_size == 0 || command_line_size == 0 {
            return Err(PvmLinuxImageError::InvalidKernel);
        }
        Ok(Self {
            payload_offset,
            code32_start,
            pref_address,
            init_size,
            initrd_address_max,
            command_line_size,
            setup_header_end,
        })
    }

    fn load_address(&self) -> u64 {
        if self.pref_address == 0 {
            u64::from(self.code32_start)
        } else {
            self.pref_address
        }
    }
}

fn validate_memory_size(memory_size: usize) -> Result<(), PvmLinuxImageError> {
    let bootstrap_end = BOOT_PD_START + BOOT_PD_COUNT * 4096;
    if memory_size < MIN_MEMORY_SIZE
        || !memory_size.is_multiple_of(4096)
        || bootstrap_end > BOOT_CMDLINE
        || memory_size > MAX_PVM_LINUX_MEMORY_SIZE
    {
        return Err(PvmLinuxImageError::InvalidMemoryLayout);
    }
    Ok(())
}

fn checked_end(
    start: usize,
    length: usize,
    memory_size: usize,
) -> Result<usize, PvmLinuxImageError> {
    let end = start
        .checked_add(length)
        .ok_or(PvmLinuxImageError::InvalidMemoryLayout)?;
    if end > memory_size {
        return Err(PvmLinuxImageError::InvalidMemoryLayout);
    }
    Ok(end)
}

fn align_up(value: usize, alignment: usize) -> Option<usize> {
    value
        .checked_add(alignment.checked_sub(1)?)
        .map(|rounded| rounded & !(alignment - 1))
}

fn place_initramfs(
    size: usize,
    memory_size: usize,
    address_max: u32,
    kernel_end: usize,
) -> Result<usize, PvmLinuxImageError> {
    if size == 0 {
        return Ok(memory_size);
    }
    let limit = memory_size.min(
        usize::try_from(address_max)
            .map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?
            .checked_add(1)
            .ok_or(PvmLinuxImageError::InvalidMemoryLayout)?,
    );
    let unaligned = limit
        .checked_sub(size)
        .ok_or(PvmLinuxImageError::InvalidMemoryLayout)?;
    let start = unaligned & !0xfff;
    if start < kernel_end {
        return Err(PvmLinuxImageError::InvalidMemoryLayout);
    }
    Ok(start)
}

fn install_boot_params(
    memory: &mut [u8],
    memory_size: usize,
    command_line: &[u8],
    kernel_start: usize,
    initramfs_start: usize,
    initramfs_size: usize,
) -> Result<(), PvmLinuxImageError> {
    memory[BOOT_PARAMS + 0x210] = 0xff;
    put_u32(
        memory,
        BOOT_PARAMS + 0x214,
        u32::try_from(kernel_start).map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?,
    );
    put_u32(
        memory,
        BOOT_PARAMS + 0x228,
        u32::try_from(BOOT_CMDLINE).map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?,
    );
    put_u32(memory, BOOT_PARAMS + 0x0c8, 0);
    if initramfs_size == 0 {
        put_u32(memory, BOOT_PARAMS + 0x218, 0);
        put_u32(memory, BOOT_PARAMS + 0x21c, 0);
        put_u32(memory, BOOT_PARAMS + 0x0c0, 0);
        put_u32(memory, BOOT_PARAMS + 0x0c4, 0);
    } else {
        put_u32(
            memory,
            BOOT_PARAMS + 0x218,
            u32::try_from(initramfs_start).map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?,
        );
        put_u32(
            memory,
            BOOT_PARAMS + 0x21c,
            u32::try_from(initramfs_size).map_err(|_| PvmLinuxImageError::InvalidMemoryLayout)?,
        );
        put_u32(memory, BOOT_PARAMS + 0x0c0, 0);
        put_u32(memory, BOOT_PARAMS + 0x0c4, 0);
    }
    memory[BOOT_CMDLINE + command_line.len()] = 0;

    memory[BOOT_PARAMS + E820_ENTRIES] = 2;
    install_e820_entry(memory, 0, 0, 0x9fc00, E820_RAM);
    install_e820_entry(
        memory,
        1,
        0x10_0000,
        (memory_size as u64) - 0x10_0000,
        E820_RAM,
    );
    Ok(())
}

fn install_e820_entry(memory: &mut [u8], index: usize, address: u64, size: u64, kind: u32) {
    let offset = BOOT_PARAMS + E820_TABLE + index * E820_ENTRY_SIZE;
    memory[offset..offset + 8].copy_from_slice(&address.to_le_bytes());
    memory[offset + 8..offset + 16].copy_from_slice(&size.to_le_bytes());
    memory[offset + 16..offset + 20].copy_from_slice(&kind.to_le_bytes());
}

fn install_bootstrap_page_tables(memory: &mut [u8]) {
    put_u64(memory, BOOT_PML4, (BOOT_PDPT as u64) | 0x3);
    for pd_index in 0..BOOT_PD_COUNT {
        let pd = BOOT_PD_START + pd_index * 4096;
        put_u64(memory, BOOT_PDPT + pd_index * 8, (pd as u64) | 0x3);
        for entry in 0..512 {
            let page = (pd_index * 512 + entry) as u64 * 0x20_0000;
            put_u64(memory, pd + entry * 8, page | 0x83);
        }
    }
}

fn install_bootstrap_gdt(memory: &mut [u8]) {
    put_u64(memory, BOOT_GDT, 0);
    put_u64(memory, BOOT_GDT + 8, 0);
    put_u64(memory, BOOT_GDT + 16, 0x00af_9a00_0000_ffff);
    put_u64(memory, BOOT_GDT + 24, 0x00cf_9200_0000_ffff);
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, PvmLinuxImageError> {
    bytes
        .get(offset..offset + 2)
        .and_then(|value| value.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or(PvmLinuxImageError::InvalidKernel)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, PvmLinuxImageError> {
    bytes
        .get(offset..offset + 4)
        .and_then(|value| value.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(PvmLinuxImageError::InvalidKernel)
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, PvmLinuxImageError> {
    bytes
        .get(offset..offset + 8)
        .and_then(|value| value.try_into().ok())
        .map(u64::from_le_bytes)
        .ok_or(PvmLinuxImageError::InvalidKernel)
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use minisandbox_pvm_sys::{
        PVM_VIRTIO_BLK_DATA_MMIO_BASE, PVM_VIRTIO_BLK_MMIO_BASE,
        PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE,
    };

    use super::{
        MAX_PVM_LINUX_MEMORY_SIZE, PvmLinuxImageError, READ_ONLY_ROOTFS_GPA, validate_memory_size,
    };

    #[test]
    fn physical_layout_caps_contiguous_ram_before_device_holes() {
        assert_eq!(validate_memory_size(MAX_PVM_LINUX_MEMORY_SIZE), Ok(()));
        assert_eq!(
            validate_memory_size(MAX_PVM_LINUX_MEMORY_SIZE + 4096),
            Err(PvmLinuxImageError::InvalidMemoryLayout)
        );
        assert!(MAX_PVM_LINUX_MEMORY_SIZE as u64 <= PVM_VIRTIO_BLK_MMIO_BASE);
        assert_eq!(
            PVM_VIRTIO_BLK_MMIO_BASE + 4096,
            PVM_VIRTIO_BLK_DATA_MMIO_BASE
        );
        assert_eq!(
            PVM_VIRTIO_BLK_DATA_MMIO_BASE + 4096,
            PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE
        );
        assert!(PVM_VIRTIO_BLK_TEMPLATE_MMIO_BASE + 4096 <= READ_ONLY_ROOTFS_GPA);
    }
}
