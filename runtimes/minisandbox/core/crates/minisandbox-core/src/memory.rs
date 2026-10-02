//! Checked guest-address and memory operations.

use core::ops::Range;

/// Highest address in the `x86_64` lower canonical half.
pub const MAX_LOWER_CANONICAL: u64 = 0x0000_7fff_ffff_ffff;

/// Failure while validating or manipulating guest memory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryError {
    /// An address is outside the supported lower canonical half.
    NonCanonical,
    /// Unsigned address arithmetic overflowed.
    AddressOverflow,
    /// A byte range lies outside the allocated guest-memory buffer.
    OutOfBounds,
}

/// An owned guest-memory byte buffer with checked access.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestMemory {
    bytes: Vec<u8>,
}

impl GuestMemory {
    /// Allocates zero-initialized guest memory.
    #[must_use]
    pub fn new(size: usize) -> Self {
        Self {
            bytes: vec![0; size],
        }
    }

    /// Returns the allocation size in bytes.
    #[must_use]
    pub const fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Returns whether the allocation contains no bytes.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// Borrows the complete guest-memory image.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Copies host bytes into a validated guest range.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::OutOfBounds`] before copying when the complete
    /// destination range is not inside this allocation.
    pub fn write(&mut self, address: GuestAddress, source: &[u8]) -> Result<(), MemoryError> {
        let range = self.checked_range(address, source.len())?;
        self.bytes[range].copy_from_slice(source);
        Ok(())
    }

    /// Borrows a validated guest byte range.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::OutOfBounds`] before indexing when the complete
    /// source range is not inside this allocation.
    pub fn read(&self, address: GuestAddress, length: usize) -> Result<&[u8], MemoryError> {
        let range = self.checked_range(address, length)?;
        Ok(&self.bytes[range])
    }

    fn checked_range(
        &self,
        address: GuestAddress,
        length: usize,
    ) -> Result<Range<usize>, MemoryError> {
        let start = usize::try_from(address.get()).map_err(|_| MemoryError::OutOfBounds)?;
        let end = start.checked_add(length).ok_or(MemoryError::OutOfBounds)?;
        if end > self.bytes.len() {
            return Err(MemoryError::OutOfBounds);
        }
        Ok(start..end)
    }
}

/// A validated `x86_64` guest address in the lower canonical half.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct GuestAddress(u64);

impl GuestAddress {
    /// Validates a raw guest address.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::NonCanonical`] for addresses above the supported
    /// lower canonical half.
    pub const fn new(address: u64) -> Result<Self, MemoryError> {
        if address <= MAX_LOWER_CANONICAL {
            Ok(Self(address))
        } else {
            Err(MemoryError::NonCanonical)
        }
    }

    /// Returns the validated raw address.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    /// Adds an unsigned byte displacement while preserving canonicality.
    ///
    /// # Errors
    ///
    /// Returns [`MemoryError::AddressOverflow`] on integer overflow and
    /// [`MemoryError::NonCanonical`] when the result crosses the supported
    /// canonical-address boundary.
    pub const fn checked_add(self, displacement: u64) -> Result<Self, MemoryError> {
        match self.0.checked_add(displacement) {
            Some(address) => Self::new(address),
            None => Err(MemoryError::AddressOverflow),
        }
    }
}
