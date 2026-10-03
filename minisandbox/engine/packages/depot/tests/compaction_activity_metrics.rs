use depot::metrics::{
	CompactionActivityGuard, SQLITE_COMPACTION_BACKLOG_BYTES, SQLITE_COMPACTION_BACKLOG_OBJECTS,
	SQLITE_COMPACTION_BYTES_TOTAL, SQLITE_COMPACTION_DURATION, SQLITE_COMPACTION_JOBS_TOTAL,
	SQLITE_COMPACTION_OBJECTS_TOTAL,
};

fn assert_cancelled(operation: &'static str) {
	assert_eq!(
		SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&[operation, "cancelled"])
			.get(),
		1
	);
	assert_eq!(
		SQLITE_COMPACTION_DURATION
			.with_label_values(&[operation, "cancelled"])
			.get_sample_count(),
		1
	);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[operation])
			.get(),
		0
	);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[operation])
			.get(),
		0
	);
}

#[test]
fn completed_attempt_is_recorded_once_without_cancellation() {
	let operation = "test_compaction_finished";
	let activity = CompactionActivityGuard::new(operation, 2, 4_096);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[operation])
			.get(),
		2
	);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[operation])
			.get(),
		4_096
	);
	activity.finish("succeeded", 3, 8_192);
	assert_eq!(
		SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&[operation, "succeeded"])
			.get(),
		1
	);
	assert_eq!(
		SQLITE_COMPACTION_JOBS_TOTAL
			.with_label_values(&[operation, "cancelled"])
			.get(),
		0
	);
	assert_eq!(
		SQLITE_COMPACTION_DURATION
			.with_label_values(&[operation, "succeeded"])
			.get_sample_count(),
		1
	);
	assert_eq!(
		SQLITE_COMPACTION_OBJECTS_TOTAL
			.with_label_values(&[operation])
			.get(),
		3
	);
	assert_eq!(
		SQLITE_COMPACTION_BYTES_TOTAL
			.with_label_values(&[operation])
			.get(),
		8_192
	);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_OBJECTS
			.with_label_values(&[operation])
			.get(),
		0
	);
	assert_eq!(
		SQLITE_COMPACTION_BACKLOG_BYTES
			.with_label_values(&[operation])
			.get(),
		0
	);
}

#[test]
fn dropped_attempt_records_cancelled_cost_and_releases_backlog() {
	let operation = "test_compaction_dropped";
	drop(CompactionActivityGuard::new(operation, 2, 4_096));
	assert_cancelled(operation);
}

#[test]
fn panicked_attempt_records_cancelled_cost_and_releases_backlog() {
	let operation = "test_compaction_panicked";
	assert!(
		std::panic::catch_unwind(|| {
			let _activity = CompactionActivityGuard::new(operation, 2, 4_096);
			panic!("test activity unwound before producing a result");
		})
		.is_err()
	);
	assert_cancelled(operation);
}

#[tokio::test]
async fn aborted_future_records_cancelled_cost_after_join() {
	let operation = "test_compaction_aborted";
	let (started_tx, started_rx) = tokio::sync::oneshot::channel();
	let task = tokio::spawn(async move {
		let _activity = CompactionActivityGuard::new(operation, 2, 4_096);
		started_tx.send(()).unwrap();
		std::future::pending::<()>().await;
	});
	started_rx.await.unwrap();
	task.abort();
	assert!(task.await.unwrap_err().is_cancelled());
	assert_cancelled(operation);
}

#[test]
fn replay_and_error_are_not_new_successful_work() {
	for (operation, result) in [
		("test_compaction_replayed", "already_applied"),
		("test_compaction_error", "error"),
	] {
		CompactionActivityGuard::new(operation, 0, 0).finish(result, 3, 8_192);
		assert_eq!(
			SQLITE_COMPACTION_JOBS_TOTAL
				.with_label_values(&[operation, result])
				.get(),
			1
		);
		assert_eq!(
			SQLITE_COMPACTION_JOBS_TOTAL
				.with_label_values(&[operation, "cancelled"])
				.get(),
			0
		);
		assert_eq!(
			SQLITE_COMPACTION_OBJECTS_TOTAL
				.with_label_values(&[operation])
				.get(),
			0
		);
		assert_eq!(
			SQLITE_COMPACTION_BYTES_TOTAL
				.with_label_values(&[operation])
				.get(),
			0
		);
	}
}
