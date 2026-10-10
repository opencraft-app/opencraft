use std::sync::Arc;

use anyhow::{Context, Result};
use rivet_test_deps::TestDeps;
use serde_json::value::RawValue;

use super::*;
use crate::db::Database;
use crate::history::location::Coordinate;

const WORKFLOW_NAME: &str = "debug-history-fixture";
const SIGNAL_NAME: &str = "debug-history-signal";

async fn signal_history(
	sizes: &[usize],
) -> Result<(
	TestDeps,
	Arc<DatabaseKv>,
	Id,
	Location,
	Vec<serde_json::Value>,
)> {
	let deps = TestDeps::new().await?;
	let db = DatabaseKv::new(deps.config().clone(), deps.pools().clone()).await?;
	let workflow_id = Id::new_v1(1);
	let input = RawValue::from_string("{}".to_string())?;
	db.dispatch_workflow(
		Id::new_v1(1),
		workflow_id,
		WORKFLOW_NAME,
		None,
		&input,
		false,
	)
	.await?;
	for (ordinal, size) in sizes.iter().enumerate() {
		let value = serde_json::json!({"ordinal": ordinal, "payload": "中文🔧".repeat(*size)});
		let raw = RawValue::from_string(serde_json::to_string(&value)?)?;
		db.publish_signal(Id::new_v1(1), workflow_id, Id::new_v1(1), SIGNAL_NAME, &raw)
			.await?;
	}
	let location = Location::new(Box::new([Coordinate::simple(1)]));
	let received = db
		.pull_next_signals(
			workflow_id,
			WORKFLOW_NAME,
			&[SIGNAL_NAME],
			&location,
			1,
			None,
			sizes.len(),
			true,
			None,
		)
		.await?;
	assert_eq!(received.len(), sizes.len());
	let bodies = received
		.iter()
		.map(|signal| serde_json::from_str(signal.body.get()))
		.collect::<std::result::Result<Vec<_>, _>>()?;
	Ok((deps, db, workflow_id, location, bodies))
}

#[tokio::test]
async fn debug_history_reads_multichunk_signals_and_matches_live_replay() -> Result<()> {
	// Each large body spans several real UDB values, including UTF-8 boundaries.
	let (_deps, db, workflow_id, location, expected) = signal_history(&[3001, 1, 5003]).await?;
	let replay = db
		.pull_workflows(Id::new_v1(1), 1, &[WORKFLOW_NAME], 1)
		.await?;
	let workflow = replay
		.workflows
		.first()
		.context("workflow must be replayable")?;
	assert_eq!(workflow.workflow_id, workflow_id);
	let event = &workflow.events[&location.root()][0];
	let crate::history::event::EventData::Signals(signals) = &event.data else {
		anyhow::bail!("expected persisted signals replay");
	};
	assert_eq!(signals.bodies.len(), expected.len());
	for (body, value) in signals.bodies.iter().zip(&expected) {
		assert_eq!(
			serde_json::from_str::<serde_json::Value>(body.get())?,
			*value
		);
	}
	for include_forgotten in [false, true] {
		let history = db
			.get_workflow_history(workflow_id, include_forgotten)
			.await?
			.context("workflow must have debug history")?;
		assert_eq!(history.events.len(), 1);
		let EventData::Signals(signals) = &history.events[0].data else {
			anyhow::bail!("expected debug signals event");
		};
		assert_eq!(signals.bodies, expected);
		assert_eq!(signals.names, vec![SIGNAL_NAME; expected.len()]);
	}
	Ok(())
}

#[tokio::test]
async fn debug_history_reads_single_chunk_signal() -> Result<()> {
	let (_deps, db, workflow_id, _, expected) = signal_history(&[1]).await?;
	let history = db
		.get_workflow_history(workflow_id, false)
		.await?
		.context("history")?;
	let EventData::Signals(signals) = &history.events[0].data else {
		anyhow::bail!("expected signals event");
	};
	assert_eq!(signals.bodies, expected);
	Ok(())
}

#[tokio::test]
async fn debug_history_rejects_missing_signal_input_index() -> Result<()> {
	let (_deps, db, workflow_id, location, _) = signal_history(&[1, 2]).await?;
	let input = db.subspace.subspace(&keys::history::IndexedInputKey::new(
		workflow_id,
		location,
		0,
	));
	let (start, end) = input.range();
	db.pools
		.udb()?
		.txn("remove_debug_history_signal_input", |tx| {
			let start = start.clone();
			let end = end.clone();
			async move {
				tx.clear_range(&start, &end);
				Ok(())
			}
		})
		.await?;
	let error = db
		.get_workflow_history(workflow_id, false)
		.await
		.expect_err("missing signal input must be rejected");
	assert!(format!("{error:#}").contains("corrupt history, indexed chunk"));
	Ok(())
}

#[tokio::test]
async fn debug_history_rejects_invalid_input_chunk() -> Result<()> {
	let (_deps, db, workflow_id, location, _) = signal_history(&[3001]).await?;
	let key = keys::history::IndexedInputKey::new(workflow_id, location, 0).chunk(0);
	let packed = db.subspace.pack(&key);
	db.pools
		.udb()?
		.txn("corrupt_debug_history_signal_input", |tx| {
			let packed = packed.clone();
			async move {
				tx.set(&packed, &[0xff]);
				Ok(())
			}
		})
		.await?;
	assert!(db.get_workflow_history(workflow_id, false).await.is_err());
	Ok(())
}
