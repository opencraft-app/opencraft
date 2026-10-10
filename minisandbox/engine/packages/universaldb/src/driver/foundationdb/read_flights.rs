use std::{future::Future, pin::Pin};

use futures_util::{StreamExt, stream::FuturesUnordered};
use tokio::sync::mpsc;

// A lookup currently needs ten independent point reads. Bound native futures per transaction
// without turning that lookup into ten sequential network waits.
pub(super) const MAX_POINT_READS_IN_FLIGHT: usize = 16;

pub(super) struct ReadFlights {
	flights: FuturesUnordered<Pin<Box<dyn Future<Output = ()> + Send>>>,
}

impl ReadFlights {
	pub(super) fn new() -> Self {
		Self {
			flights: FuturesUnordered::new(),
		}
	}

	pub(super) fn push(&mut self, flight: impl Future<Output = ()> + Send + 'static) {
		assert!(self.flights.len() < MAX_POINT_READS_IN_FLIGHT);
		self.flights.push(Box::pin(flight));
	}

	pub(super) async fn next_command<T>(
		&mut self,
		receiver: &mut mpsc::UnboundedReceiver<T>,
	) -> Option<T> {
		loop {
			if self.flights.len() == MAX_POINT_READS_IN_FLIGHT {
				self.flights.next().await;
			}
			tokio::select! {
				command = receiver.recv() => return command,
				Some(()) = self.flights.next(), if !self.flights.is_empty() => {}
			}
		}
	}

	// The caller drains before every mutation, range read, option change, commit, or retry.
	// No native read may cross a transaction-state boundary or observe a later queued write.
	pub(super) async fn drain(&mut self) {
		while self.flights.next().await.is_some() {}
	}
}

#[cfg(test)]
#[path = "../../../tests/inline/foundationdb_read_flights.rs"]
mod tests;
