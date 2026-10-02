//! Host-owned cursors for validating untrusted shared-ring indices.

/// An invalid update published by the untrusted peer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorError {
    /// A zero-sized or ambiguously large ring was requested.
    InvalidCapacity,
    /// The peer claims more entries than the bounded ring can contain.
    PeerAdvancedTooFar,
    /// The producer has no free descriptor.
    Full,
    /// The consumer has no published descriptor.
    Empty,
}

const fn capacity_is_valid<const N: usize>() -> bool {
    N > 0 && N <= i32::MAX as usize
}

/// The host cursor while consuming a guest-produced ring.
///
/// `published` is untrusted.  The host keeps `consumed` privately and rejects
/// any producer jump larger than the complete ring.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConsumerCursor<const N: usize> {
    consumed: u32,
}

impl<const N: usize> ConsumerCursor<N> {
    /// Creates an empty consumer cursor.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::InvalidCapacity`] when `N` is not unambiguous.
    pub fn new() -> Result<Self, CursorError> {
        Self::from_consumed(0)
    }

    /// Creates a cursor at an explicit wrapping sequence number.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::InvalidCapacity`] when `N` is not unambiguous.
    pub const fn from_consumed(consumed: u32) -> Result<Self, CursorError> {
        if capacity_is_valid::<N>() {
            Ok(Self { consumed })
        } else {
            Err(CursorError::InvalidCapacity)
        }
    }

    /// Returns the host-private number of consumed descriptors.
    #[must_use]
    pub const fn consumed(self) -> u32 {
        self.consumed
    }

    /// Validates the peer producer and returns the number of available entries.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::PeerAdvancedTooFar`] for an impossible peer index.
    pub fn available(self, published: u32) -> Result<usize, CursorError> {
        let available = published.wrapping_sub(self.consumed) as usize;
        if available > N {
            Err(CursorError::PeerAdvancedTooFar)
        } else {
            Ok(available)
        }
    }

    /// Returns the next physical ring index without consuming it.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::Empty`] or an impossible-peer error.
    pub fn next_index(self, published: u32) -> Result<usize, CursorError> {
        if self.available(published)? == 0 {
            return Err(CursorError::Empty);
        }
        Ok(self.consumed as usize % N)
    }

    /// Consumes one previously validated descriptor.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::Empty`] or an impossible-peer error.
    pub fn consume_one(&mut self, published: u32) -> Result<usize, CursorError> {
        let index = self.next_index(published)?;
        self.consumed = self.consumed.wrapping_add(1);
        Ok(index)
    }
}

/// The host cursor while producing a guest-consumed ring.
///
/// The guest-owned `reported_consumer` value is never authoritative.  It may
/// advance only through entries that the host has actually produced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProducerCursor<const N: usize> {
    produced: u32,
    observed_consumed: u32,
}

impl<const N: usize> ProducerCursor<N> {
    /// Creates an empty producer cursor.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::InvalidCapacity`] when `N` is not unambiguous.
    pub fn new() -> Result<Self, CursorError> {
        Self::from_counters(0, 0)
    }

    /// Creates a producer at explicit wrapping sequence numbers.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid capacity or impossible initial counters.
    pub const fn from_counters(produced: u32, observed_consumed: u32) -> Result<Self, CursorError> {
        if !capacity_is_valid::<N>() {
            return Err(CursorError::InvalidCapacity);
        }
        let outstanding = produced.wrapping_sub(observed_consumed) as usize;
        if outstanding > N {
            return Err(CursorError::PeerAdvancedTooFar);
        }
        Ok(Self {
            produced,
            observed_consumed,
        })
    }

    /// Returns the number of descriptors produced by the host.
    #[must_use]
    pub const fn produced(self) -> u32 {
        self.produced
    }

    /// Validates and records a guest consumer update.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::PeerAdvancedTooFar`] when the guest claims work
    /// that the host never produced.
    pub fn observe_consumer(&mut self, reported_consumer: u32) -> Result<(), CursorError> {
        let newly_consumed = reported_consumer.wrapping_sub(self.observed_consumed) as usize;
        let outstanding = self.produced.wrapping_sub(self.observed_consumed) as usize;
        if newly_consumed > outstanding {
            return Err(CursorError::PeerAdvancedTooFar);
        }
        self.observed_consumed = reported_consumer;
        Ok(())
    }

    /// Returns the number of descriptors the host may still publish.
    #[must_use]
    pub fn free(self) -> usize {
        N - self.produced.wrapping_sub(self.observed_consumed) as usize
    }

    /// Reserves one physical descriptor index for the host.
    ///
    /// # Errors
    ///
    /// Returns [`CursorError::Full`] when every descriptor is outstanding.
    pub fn reserve_one(&mut self) -> Result<usize, CursorError> {
        if self.free() == 0 {
            return Err(CursorError::Full);
        }
        let index = self.produced as usize % N;
        self.produced = self.produced.wrapping_add(1);
        Ok(index)
    }
}
