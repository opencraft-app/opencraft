//! Clone-local socket resource and bandwidth quotas.

use std::{
    num::NonZeroU64,
    time::{Duration, Instant},
};

/// Maximum active TCP and restricted-DNS host descriptors owned by one clone.
pub const MAX_ACTIVE_SOCKET_FDS: usize = 128;
/// Maximum accepted host streams waiting for one clone to acknowledge/accept.
pub const MAX_PENDING_INGRESS_OFFERS: usize = 32;
/// Fixed clone-global TX or RX payload bytes represented by one mailbox side.
pub const CLONE_MAILBOX_BUFFER_BYTES_PER_DIRECTION: usize = 32 * 4096;
/// Maximum outstanding TX or RX payload bytes for one stream.
pub const STREAM_BUFFER_BYTES_PER_DIRECTION: usize = 4 * 4096;

/// One aggregate byte-rate limit with a bounded initial/refill burst.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BandwidthQuota {
    /// Sustained bytes made available per second.
    pub bytes_per_second: NonZeroU64,
    /// Maximum accumulated byte credit.
    pub burst_bytes: NonZeroU64,
}

/// Host resources admitted for one socket-service worker/clone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SocketQuotas {
    /// Active TCP plus restricted-DNS descriptors, excluding pending ingress.
    pub active_socket_fds: usize,
    /// Host streams in the command channel or pending ingress table.
    pub pending_ingress_offers: usize,
    /// Aggregate guest-to-network TCP bytes; `None` means no rate throttle.
    pub egress_bandwidth: Option<BandwidthQuota>,
    /// Aggregate network-to-guest TCP bytes; `None` means no rate throttle.
    pub ingress_bandwidth: Option<BandwidthQuota>,
}

impl Default for SocketQuotas {
    fn default() -> Self {
        Self {
            active_socket_fds: MAX_ACTIVE_SOCKET_FDS,
            pending_ingress_offers: MAX_PENDING_INGRESS_OFFERS,
            egress_bandwidth: None,
            ingress_bandwidth: None,
        }
    }
}

impl SocketQuotas {
    pub(crate) fn validate(self) -> Result<Self, &'static str> {
        if self.active_socket_fds == 0 || self.active_socket_fds > MAX_ACTIVE_SOCKET_FDS {
            return Err("active socket FD quota must be in 1..=128");
        }
        if self.pending_ingress_offers == 0
            || self.pending_ingress_offers > MAX_PENDING_INGRESS_OFFERS
        {
            return Err("pending ingress quota must be in 1..=32");
        }
        Ok(self)
    }
}

pub(crate) struct TokenBucket {
    limit: Option<BandwidthQuota>,
    credit_nanos: u128,
    updated: Instant,
}

impl TokenBucket {
    pub(crate) fn new(limit: Option<BandwidthQuota>) -> Self {
        let updated = Instant::now();
        let credit_nanos = limit.map_or(0, |quota| {
            u128::from(quota.burst_bytes.get()) * 1_000_000_000
        });
        Self {
            limit,
            credit_nanos,
            updated,
        }
    }

    pub(crate) fn allowance(&mut self, maximum: usize) -> usize {
        self.allowance_at(Instant::now(), maximum)
    }

    pub(crate) fn consume(&mut self, bytes: usize) {
        let Some(_) = self.limit else {
            return;
        };
        self.credit_nanos = self
            .credit_nanos
            .saturating_sub((bytes as u128) * 1_000_000_000);
    }

    pub(crate) fn delay_until_credit(&mut self) -> Option<Duration> {
        self.delay_until_credit_at(Instant::now())
    }

    fn allowance_at(&mut self, now: Instant, maximum: usize) -> usize {
        let Some(quota) = self.limit else {
            return maximum;
        };
        self.refill(now, quota);
        let available = self.credit_nanos / 1_000_000_000;
        maximum.min(usize::try_from(available).unwrap_or(usize::MAX))
    }

    fn delay_until_credit_at(&mut self, now: Instant) -> Option<Duration> {
        let quota = self.limit?;
        self.refill(now, quota);
        if self.credit_nanos >= 1_000_000_000 {
            return Some(Duration::ZERO);
        }
        let missing = 1_000_000_000 - self.credit_nanos;
        let rate = u128::from(quota.bytes_per_second.get());
        let nanoseconds = missing.div_ceil(rate).min(u128::from(u64::MAX));
        Some(Duration::from_nanos(
            u64::try_from(nanoseconds).expect("nanoseconds capped to u64"),
        ))
    }

    fn refill(&mut self, now: Instant, quota: BandwidthQuota) {
        let elapsed = now.saturating_duration_since(self.updated).as_nanos();
        self.updated = now;
        let maximum = u128::from(quota.burst_bytes.get()) * 1_000_000_000;
        self.credit_nanos = self
            .credit_nanos
            .saturating_add(elapsed.saturating_mul(u128::from(quota.bytes_per_second.get())))
            .min(maximum);
    }
}

#[cfg(test)]
mod tests {
    use std::{num::NonZeroU64, time::Duration};

    use super::{BandwidthQuota, TokenBucket};

    #[test]
    fn token_bucket_enforces_burst_rate_and_fractional_refill() {
        let quota = BandwidthQuota {
            bytes_per_second: NonZeroU64::new(10).unwrap(),
            burst_bytes: NonZeroU64::new(4).unwrap(),
        };
        let mut bucket = TokenBucket::new(Some(quota));
        let start = bucket.updated;
        assert_eq!(bucket.allowance_at(start, 4096), 4);
        bucket.consume(4);
        assert_eq!(bucket.allowance_at(start, 4096), 0);
        assert_eq!(
            bucket.delay_until_credit_at(start),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            bucket.allowance_at(start + Duration::from_millis(250), 4096),
            2
        );
        bucket.consume(2);
        assert_eq!(
            bucket.allowance_at(start + Duration::from_secs(10), 4096),
            4
        );
    }
}
