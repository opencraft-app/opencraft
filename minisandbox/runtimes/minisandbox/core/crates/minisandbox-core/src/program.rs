//! Strict, allocation-bounded ELF64 program parsing.

use crate::memory::GuestAddress;

const ELF_HEADER_SIZE: usize = 64;
const PROGRAM_HEADER_SIZE: usize = 56;
const ET_EXEC: u16 = 2;
const ET_DYN: u16 = 3;
const PT_LOAD: u32 = 1;
const PT_INTERP: u32 = 3;
const STATIC_PIE_LOAD_BIAS: u64 = 0x40_0000;
const MAX_INTERPRETER_PATH: usize = 4096;

/// Semantic permissions accepted for one loadable segment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SegmentPermissions(u8);

impl SegmentPermissions {
    /// Readable, but neither writable nor executable.
    pub const READ_ONLY: Self = Self(0b001);
    /// Readable and executable segment.
    pub const READ_EXECUTE: Self = Self(0b101);
    /// Readable and writable segment.
    pub const READ_WRITE: Self = Self(0b011);

    /// Returns whether the segment is writable.
    #[must_use]
    pub const fn is_writable(self) -> bool {
        self.0 & 0b010 != 0
    }

    /// Returns whether the segment is executable.
    #[must_use]
    pub const fn is_executable(self) -> bool {
        self.0 & 0b100 != 0
    }
}

/// Failure while parsing a supported ELF image.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProgramError {
    /// ELF or program-header bytes end before a required field/range.
    Truncated,
    /// ELF class is not 64-bit.
    UnsupportedClass,
    /// ELF encoding is not little-endian.
    UnsupportedEndian,
    /// ELF machine is not `x86_64`.
    WrongMachine,
    /// The ELF carries a malformed or unbounded userspace interpreter request.
    UnsupportedInterpreter,
    /// A load segment requests write and execute permission together.
    WritableExecutable,
    /// A segment's in-memory size is smaller than its file-backed size.
    MemorySmallerThanFile,
    /// A segment's file range is outside the input image.
    SegmentOutOfBounds,
    /// Two load segments overlap in guest virtual memory.
    OverlappingSegments,
    /// A load segment starts or ends outside the lower canonical half.
    NonCanonicalSegment,
    /// Program entry is not inside an executable load segment.
    EntryNotExecutable,
    /// The input does not satisfy the supported ELF contract.
    InvalidElf,
}

/// One validated ELF load segment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadSegment {
    file_offset: u64,
    virtual_address: GuestAddress,
    file_bytes: Vec<u8>,
    memory_size: u64,
    permissions: SegmentPermissions,
}

impl LoadSegment {
    /// Returns the segment's starting user virtual address.
    #[must_use]
    pub const fn virtual_address(&self) -> GuestAddress {
        self.virtual_address
    }

    /// Borrows bytes present in the ELF file.
    #[must_use]
    pub fn file_bytes(&self) -> &[u8] {
        &self.file_bytes
    }

    /// Returns the in-memory size, including zero-filled BSS.
    #[must_use]
    pub const fn memory_size(&self) -> u64 {
        self.memory_size
    }

    /// Returns validated segment permissions.
    #[must_use]
    pub const fn permissions(&self) -> SegmentPermissions {
        self.permissions
    }
}

/// A validated `x86_64` ELF program and optional interpreter request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Program {
    entry: GuestAddress,
    segments: Vec<LoadSegment>,
    headers: Option<ProgramHeaders>,
    load_bias: u64,
    interpreter: Option<Vec<u8>>,
}

/// In-memory location of the ELF program-header table for Linux startup.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProgramHeaders {
    address: GuestAddress,
    count: u16,
    entry_size: u16,
}

impl ProgramHeaders {
    /// Returns the user virtual address of the first program header.
    #[must_use]
    pub const fn address(self) -> GuestAddress {
        self.address
    }

    /// Returns the number of entries in the table.
    #[must_use]
    pub const fn count(self) -> u16 {
        self.count
    }

    /// Returns the byte size of each program-header entry.
    #[must_use]
    pub const fn entry_size(self) -> u16 {
        self.entry_size
    }
}

impl Program {
    /// Parses the supported ELF64 little-endian `x86_64` subset.
    ///
    /// # Errors
    ///
    /// Returns [`ProgramError::InvalidElf`] for truncated, malformed, or
    /// unsupported input.
    pub fn parse_elf(bytes: &[u8]) -> Result<Self, ProgramError> {
        Self::parse_elf_at_bias(bytes, STATIC_PIE_LOAD_BIAS)
    }

    pub(crate) fn parse_elf_at_bias(
        bytes: &[u8],
        dynamic_load_bias: u64,
    ) -> Result<Self, ProgramError> {
        if dynamic_load_bias & 0xfff != 0 {
            return Err(ProgramError::InvalidElf);
        }
        let load_bias = parse_load_bias(bytes, dynamic_load_bias)?;
        let entry = GuestAddress::new(
            read_u64(bytes, 24)?
                .checked_add(load_bias)
                .ok_or(ProgramError::InvalidElf)?,
        )
        .map_err(|_| ProgramError::InvalidElf)?;
        let program_offset =
            usize::try_from(read_u64(bytes, 32)?).map_err(|_| ProgramError::InvalidElf)?;
        let program_entry_size = read_u16(bytes, 54)?;
        let program_count_raw = read_u16(bytes, 56)?;
        let program_count = usize::from(program_count_raw);
        if program_count == 0 {
            return Err(ProgramError::InvalidElf);
        }

        let mut segments = Vec::new();
        let mut interpreter = None;
        for index in 0..program_count {
            let offset = index
                .checked_mul(PROGRAM_HEADER_SIZE)
                .and_then(|value| program_offset.checked_add(value))
                .ok_or(ProgramError::InvalidElf)?;
            if read_u32(bytes, offset)? == PT_INTERP {
                if interpreter.is_some() {
                    return Err(ProgramError::InvalidElf);
                }
                interpreter = Some(parse_interpreter(bytes, offset)?);
                continue;
            }
            let Some(segment) = parse_load_segment(bytes, offset, load_bias)? else {
                continue;
            };
            let segment_start = segment.virtual_address.get();
            let segment_end = segment_start
                .checked_add(segment.memory_size)
                .ok_or(ProgramError::InvalidElf)?;
            if segments.iter().any(|segment: &LoadSegment| {
                let existing_start = segment.virtual_address.get();
                let existing_end = existing_start + segment.memory_size;
                segment_start < existing_end && existing_start < segment_end
            }) {
                return Err(ProgramError::OverlappingSegments);
            }
            segments.push(segment);
        }
        if segments.is_empty() {
            return Err(ProgramError::InvalidElf);
        }
        let executable_entry = segments.iter().any(|segment| {
            if segment.permissions != SegmentPermissions::READ_EXECUTE {
                return false;
            }
            let start = segment.virtual_address.get();
            start
                .checked_add(segment.memory_size)
                .is_some_and(|end| entry.get() >= start && entry.get() < end)
        });
        if !executable_entry {
            return Err(ProgramError::EntryNotExecutable);
        }
        let table_size = program_count
            .checked_mul(PROGRAM_HEADER_SIZE)
            .ok_or(ProgramError::InvalidElf)?;
        let table_end = program_offset
            .checked_add(table_size)
            .ok_or(ProgramError::InvalidElf)?;
        let headers = segments.iter().find_map(|segment| {
            let file_start = usize::try_from(segment.file_offset).ok()?;
            let file_end = file_start.checked_add(segment.file_bytes.len())?;
            if program_offset < file_start || table_end > file_end {
                return None;
            }
            let displacement = u64::try_from(program_offset - file_start).ok()?;
            Some(ProgramHeaders {
                address: segment.virtual_address.checked_add(displacement).ok()?,
                count: program_count_raw,
                entry_size: program_entry_size,
            })
        });
        Ok(Self {
            entry,
            segments,
            headers,
            load_bias,
            interpreter,
        })
    }

    /// Returns the validated user entry address.
    #[must_use]
    pub const fn entry(&self) -> GuestAddress {
        self.entry
    }

    /// Borrows load segments in program-header order.
    #[must_use]
    pub fn segments(&self) -> &[LoadSegment] {
        &self.segments
    }

    /// Returns the loaded program-header table when a `PT_LOAD` covers it.
    #[must_use]
    pub const fn program_headers(&self) -> Option<ProgramHeaders> {
        self.headers
    }

    /// Returns the applied base address for an `ET_DYN` image.
    #[must_use]
    pub const fn load_bias(&self) -> u64 {
        self.load_bias
    }

    /// Returns the requested userspace interpreter path without its NUL.
    #[must_use]
    pub fn interpreter(&self) -> Option<&[u8]> {
        self.interpreter.as_deref()
    }
}

fn parse_load_bias(bytes: &[u8], dynamic_load_bias: u64) -> Result<u64, ProgramError> {
    if bytes.len() < ELF_HEADER_SIZE {
        return Err(ProgramError::Truncated);
    }
    if bytes.get(..4) != Some(&[0x7f, b'E', b'L', b'F']) {
        return Err(ProgramError::InvalidElf);
    }
    if bytes[4] != 2 {
        return Err(ProgramError::UnsupportedClass);
    }
    if bytes[5] != 1 {
        return Err(ProgramError::UnsupportedEndian);
    }
    if read_u16(bytes, 18)? != 62 {
        return Err(ProgramError::WrongMachine);
    }
    let elf_type = read_u16(bytes, 16)?;
    if bytes[6] != 1
        || !matches!(elf_type, ET_EXEC | ET_DYN)
        || read_u32(bytes, 20)? != 1
        || usize::from(read_u16(bytes, 52)?) != ELF_HEADER_SIZE
        || usize::from(read_u16(bytes, 54)?) != PROGRAM_HEADER_SIZE
    {
        return Err(ProgramError::InvalidElf);
    }
    Ok(if elf_type == ET_DYN {
        dynamic_load_bias
    } else {
        0
    })
}

fn parse_interpreter(bytes: &[u8], offset: usize) -> Result<Vec<u8>, ProgramError> {
    let file_offset = usize::try_from(read_u64(bytes, offset + 8)?)
        .map_err(|_| ProgramError::UnsupportedInterpreter)?;
    let file_size = usize::try_from(read_u64(bytes, offset + 32)?)
        .map_err(|_| ProgramError::UnsupportedInterpreter)?;
    if !(2..=MAX_INTERPRETER_PATH).contains(&file_size) {
        return Err(ProgramError::UnsupportedInterpreter);
    }
    let end = file_offset
        .checked_add(file_size)
        .ok_or(ProgramError::UnsupportedInterpreter)?;
    let encoded = bytes
        .get(file_offset..end)
        .ok_or(ProgramError::UnsupportedInterpreter)?;
    let Some((&0, path)) = encoded.split_last() else {
        return Err(ProgramError::UnsupportedInterpreter);
    };
    if path.first() != Some(&b'/') || path.contains(&0) {
        return Err(ProgramError::UnsupportedInterpreter);
    }
    Ok(path.to_vec())
}

fn parse_load_segment(
    bytes: &[u8],
    offset: usize,
    load_bias: u64,
) -> Result<Option<LoadSegment>, ProgramError> {
    if read_u32(bytes, offset)? != PT_LOAD {
        return Ok(None);
    }
    let permissions = match read_u32(bytes, offset + 4)? {
        4 => SegmentPermissions::READ_ONLY,
        5 => SegmentPermissions::READ_EXECUTE,
        6 => SegmentPermissions::READ_WRITE,
        7 => return Err(ProgramError::WritableExecutable),
        _ => return Err(ProgramError::InvalidElf),
    };
    let file_offset = usize::try_from(read_u64(bytes, offset + 8)?)
        .map_err(|_| ProgramError::SegmentOutOfBounds)?;
    let virtual_address = GuestAddress::new(
        read_u64(bytes, offset + 16)?
            .checked_add(load_bias)
            .ok_or(ProgramError::NonCanonicalSegment)?,
    )
    .map_err(|_| ProgramError::NonCanonicalSegment)?;
    let file_size = usize::try_from(read_u64(bytes, offset + 32)?)
        .map_err(|_| ProgramError::SegmentOutOfBounds)?;
    let memory_size = read_u64(bytes, offset + 40)?;
    if memory_size < u64::try_from(file_size).map_err(|_| ProgramError::SegmentOutOfBounds)? {
        return Err(ProgramError::MemorySmallerThanFile);
    }
    if memory_size > 0 && virtual_address.checked_add(memory_size - 1).is_err() {
        return Err(ProgramError::NonCanonicalSegment);
    }
    let file_end = file_offset
        .checked_add(file_size)
        .ok_or(ProgramError::SegmentOutOfBounds)?;
    let file_bytes = bytes
        .get(file_offset..file_end)
        .ok_or(ProgramError::SegmentOutOfBounds)?
        .to_vec();
    Ok(Some(LoadSegment {
        file_offset: u64::try_from(file_offset).map_err(|_| ProgramError::SegmentOutOfBounds)?,
        virtual_address,
        file_bytes,
        memory_size,
        permissions,
    }))
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(read_array(bytes, offset)?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, ProgramError> {
    Ok(u32::from_le_bytes(read_array(bytes, offset)?))
}

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(read_array(bytes, offset)?))
}

fn read_array<const LENGTH: usize>(
    bytes: &[u8],
    offset: usize,
) -> Result<[u8; LENGTH], ProgramError> {
    let end = offset.checked_add(LENGTH).ok_or(ProgramError::InvalidElf)?;
    bytes
        .get(offset..end)
        .ok_or(ProgramError::Truncated)?
        .try_into()
        .map_err(|_| ProgramError::Truncated)
}
