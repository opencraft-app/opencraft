use std::{sync::Arc, time::Duration};

use tokio::sync::{Notify, mpsc, oneshot};

use super::{MAX_POINT_READS_IN_FLIGHT, ReadFlights};

#[tokio::test]
async fn independent_reads_do_not_wait_for_an_earlier_read() {
	let mut flights = ReadFlights::new();
	let (release, blocked) = oneshot::channel();
	let (done, finished) = oneshot::channel();
	flights.push(async move {
		blocked.await.unwrap();
	});
	flights.push(async move {
		done.send(()).unwrap();
	});
	let (sender, mut receiver) = mpsc::unbounded_channel::<()>();
	let task = tokio::spawn(async move { flights.next_command(&mut receiver).await });

	// A deadline detects a deadlock; no timing comparison or sleep determines the ordering.
	tokio::time::timeout(Duration::from_secs(2), finished)
		.await
		.unwrap()
		.unwrap();
	release.send(()).unwrap();
	sender.send(()).unwrap();
	assert_eq!(task.await.unwrap(), Some(()));
}

#[tokio::test]
async fn full_flight_set_backpressures_the_next_command() {
	let mut flights = ReadFlights::new();
	let mut releases = Vec::new();
	for _ in 0..MAX_POINT_READS_IN_FLIGHT {
		let (release, blocked) = oneshot::channel();
		releases.push(release);
		flights.push(async move { blocked.await.unwrap() });
	}
	let (sender, mut receiver) = mpsc::unbounded_channel();
	sender.send(17).unwrap();
	{
		let command = flights.next_command(&mut receiver);
		tokio::pin!(command);
		assert!(futures_util::poll!(&mut command).is_pending());
		releases.pop().unwrap().send(()).unwrap();
		assert_eq!(command.await, Some(17));
	}
	for release in releases {
		release.send(()).unwrap();
	}
	flights.drain().await;
	assert!(flights.flights.is_empty());
}

#[tokio::test]
async fn fifo_barrier_waits_for_every_earlier_read() {
	let mut flights = ReadFlights::new();
	let (release, blocked) = oneshot::channel();
	let completed = Arc::new(Notify::new());
	let notification = completed.notified();
	tokio::pin!(notification);
	notification.as_mut().enable();
	let signal = completed.clone();
	flights.push(async move {
		blocked.await.unwrap();
		signal.notify_one();
	});
	let drain = flights.drain();
	tokio::pin!(drain);
	assert!(futures_util::poll!(&mut drain).is_pending());
	release.send(()).unwrap();
	drain.await;
	notification.await;
}

#[tokio::test]
async fn closed_command_channel_can_drain_existing_reads() {
	let mut flights = ReadFlights::new();
	let (done, finished) = oneshot::channel();
	flights.push(async move {
		done.send(()).unwrap();
	});
	let (sender, mut receiver) = mpsc::unbounded_channel::<()>();
	drop(sender);
	assert_eq!(flights.next_command(&mut receiver).await, None);
	flights.drain().await;
	finished.await.unwrap();
}
