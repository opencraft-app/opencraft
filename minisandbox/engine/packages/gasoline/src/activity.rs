use std::{
	fmt::Debug,
	hash::{Hash, Hasher},
	time::Duration,
};

use anyhow::Result;
use async_trait::async_trait;
use rivet_util::Id;
use serde::{Serialize, de::DeserializeOwned};

use crate::ctx::ActivityCtx;

/// Admission is not an execution attempt. A deferred activity keeps its durable input and does
/// not consume its execution-failure budget. Admission must not mutate workflow or business state.
/// Gasoline bounds the wait independently of execution and cancels it on worker eviction.
pub enum ActivityAdmission<T> {
	Ready(Box<dyn Send>),
	Deferred(std::time::Duration),
	/// A pre-admission check can finish without acquiring an execution permit.
	Complete(T),
}

impl<T> ActivityAdmission<T> {
	/// Resource-pressure wakeups are spread across workflows and remain independent of failures.
	pub fn deferred(workflow_id: Id) -> Self {
		let mut hash = std::hash::DefaultHasher::new();
		workflow_id.hash(&mut hash);
		Self::Deferred(Duration::from_millis(60_000 + hash.finish() % 60_001))
	}
}

#[async_trait]
pub trait Activity: Send {
	type Input: ActivityInput;
	type Output: Serialize + DeserializeOwned + Debug + Send;

	const NAME: &'static str;
	/// Seconds.
	const MAX_RETRIES: usize;
	const TIMEOUT: std::time::Duration;
	const HAS_ADMISSION: bool = false;
	const ADMISSION_TIMEOUT: Duration = Duration::from_secs(30);

	async fn admit(
		_ctx: &ActivityCtx,
		_input: &Self::Input,
	) -> Result<ActivityAdmission<Self::Output>> {
		Ok(ActivityAdmission::Ready(Box::new(())))
	}

	/// Hold the permit until execution returns or is cancelled, but not during history persistence.
	async fn run_admitted(
		ctx: &ActivityCtx,
		input: &Self::Input,
		_guard: Box<dyn Send>,
	) -> Result<Self::Output> {
		Self::run(ctx, input).await
	}

	async fn run(ctx: &ActivityCtx, input: &Self::Input) -> Result<Self::Output>;
}

pub trait ActivityInput: Serialize + DeserializeOwned + Debug + Send + Sync {
	type Activity: Activity;
}
