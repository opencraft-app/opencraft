use super::refresh_with_stage_cleanup;

#[tokio::test]
async fn idle_cleanup_uses_one_transaction() {
	let mut calls = 0;
	let value = refresh_with_stage_cleanup(|| {
		calls += 1;
		std::future::ready(Ok((calls, false)))
	})
	.await
	.unwrap();
	assert_eq!((value, calls), (1, 1));
}

#[tokio::test]
async fn cleanup_returns_latest_snapshot_and_stops_without_progress() {
	let mut calls = 0;
	let value = refresh_with_stage_cleanup(|| {
		calls += 1;
		std::future::ready(Ok((calls, calls < 3)))
	})
	.await
	.unwrap();
	assert_eq!((value, calls), (3, 3));
}

#[tokio::test]
async fn large_backlog_cannot_monopolize_the_activity() {
	let mut calls = 0;
	let value = refresh_with_stage_cleanup(|| {
		calls += 1;
		std::future::ready(Ok((calls, true)))
	})
	.await
	.unwrap();
	assert_eq!((value, calls), (4, 4));
}

#[tokio::test]
async fn failed_pass_does_not_return_an_older_successful_snapshot() {
	let mut calls = 0;
	let result = refresh_with_stage_cleanup(|| {
		calls += 1;
		std::future::ready(if calls == 2 {
			Err(anyhow::anyhow!("transaction failed"))
		} else {
			Ok((calls, true))
		})
	})
	.await;
	assert!(result.is_err());
	assert_eq!(calls, 2);
}
