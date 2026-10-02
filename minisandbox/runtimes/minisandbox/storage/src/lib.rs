//! Executable models and the first `SQLite` refinement of the `MetaStore`.
//!
//! The TLA+ specifications under `spec/` remain the authoritative algorithms.
//! The `sqlite_metastore` module is implementation-level refinement evidence;
//! it does not prove `SQLite`, the filesystem, or the underlying block device.

use stateright::{Model, Property};

pub mod sqlite_metastore;

/// Maximum number of checkpoint generations represented by the finite model.
pub const MAX_GENERATIONS: usize = 2;
/// Maximum number of service incarnations represented by the finite model.
pub const MAX_EPOCH: u8 = 3;
/// Maximum number of generations allowed to retain CBS dirty data at once.
pub const DIRTY_GENERATION_LIMIT: usize = 1;

/// Safety property: a successful guest flush remains recoverable.
pub const FLUSH_DURABLE: &str = "flush acknowledgment is durable";
/// Safety property: every committed manifest refers only to existing objects.
pub const MANIFEST_COMPLETE: &str = "manifest references existing objects";
/// Safety property: reclaimed CBS data is reachable through a committed manifest.
pub const RECLAIM_SAFE: &str = "reclaimed data remains reachable";
/// Safety property: object verification cannot be fabricated.
pub const VERIFICATION_SOUND: &str = "verified objects exist";
/// Safety property: the configured dirty-data bound is never exceeded.
pub const DIRTY_BOUNDED: &str = "dirty generations remain bounded";
/// Safety property: a stale attachment epoch cannot change storage.
pub const EPOCH_FENCED: &str = "stale epochs cannot mutate storage";
/// Reachability property: both modeled generations can be committed.
pub const TWO_GENERATIONS_COMMIT: &str = "two generations can commit";
/// Reachability property: ambiguous S3 completion can be recovered with HEAD.
pub const AMBIGUOUS_PUT_RECOVERS: &str = "ambiguous S3 put can be recovered";
/// Reachability property: a transient S3 HEAD miss can be retried safely.
pub const S3_VISIBILITY_DELAY_RECOVERS: &str = "S3 visibility delay can be recovered";
/// Reachability property: committed CBS data can eventually be reclaimed.
pub const CBS_CAN_RECLAIM: &str = "CBS data can be reclaimed";
/// Reachability property: crash recovery installs a new fencing epoch.
pub const CRASH_CAN_RECOVER: &str = "crash can recover with a new epoch";

/// Deliberate protocol defects used to prove that the checker finds real bugs.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum InjectedFault {
    /// The production protocol with no injected defect.
    None,
    /// Permit a flush response before the CBS sync completes.
    AckBeforeCbsSync,
    /// Permit a manifest commit before the S3 object is verified.
    CommitBeforeS3Put,
    /// Permit CBS reclamation before manifest commit.
    ReclaimBeforeManifest,
    /// Permit an operation carrying an old attachment epoch to write.
    AcceptStaleEpoch,
}

impl InjectedFault {
    /// Returns the safety property that this deliberate defect must violate.
    #[must_use]
    pub const fn violated_property(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::AckBeforeCbsSync => Some(FLUSH_DURABLE),
            Self::CommitBeforeS3Put => Some(MANIFEST_COMPLETE),
            Self::ReclaimBeforeManifest => Some(RECLAIM_SAFE),
            Self::AcceptStaleEpoch => Some(EPOCH_FENCED),
        }
    }
}

/// Result of one immutable S3 PUT attempt.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PutOutcome {
    /// The object exists and the service observed success.
    Success,
    /// The object exists, but the response was lost or timed out.
    TimeoutAfterCommit,
    /// The request timed out before the object became durable.
    TimeoutBeforeCommit,
}

/// One atomic input to the pure protocol state machine.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Action {
    /// Accept one guest write into the current generation's CBS page cache.
    GuestWrite {
        /// Generation receiving the write.
        generation: u8,
        /// Attachment epoch carried by the request.
        epoch: u8,
    },
    /// Persist one generation to CBS.
    CbsSync {
        /// Generation made durable.
        generation: u8,
    },
    /// Complete the guest's pending FLUSH request.
    AckFlush {
        /// Generation whose FLUSH is completed.
        generation: u8,
    },
    /// Attempt to create one immutable S3 object.
    S3Put {
        /// Generation being uploaded.
        generation: u8,
        /// Observable and actual result of the request.
        outcome: PutOutcome,
    },
    /// Verify an ambiguously completed object with a successful HEAD.
    S3HeadPresent {
        /// Generation whose immutable object was found.
        generation: u8,
    },
    /// Observe a transient S3 HEAD miss without treating it as object loss.
    S3HeadAbsent {
        /// Generation whose object is not yet visible.
        generation: u8,
    },
    /// Publish a new manifest root using generation compare-and-swap.
    CommitManifest {
        /// Generation atomically made reachable.
        generation: u8,
    },
    /// Reclaim a generation from CBS.
    ReclaimCbs {
        /// Generation removed from CBS.
        generation: u8,
    },
    /// Crash the service and lose volatile process/page-cache state.
    Crash,
    /// Recover durable state and install a fresh attachment epoch.
    Recover,
    /// Submit a request bearing a superseded attachment epoch.
    StaleEpochWrite,
}

/// Finite abstract state shared by the checker and future runtime logic.
#[allow(
    clippy::struct_excessive_bools,
    reason = "explicit propositions keep the model state hashable and auditable"
)]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProtocolState {
    running: bool,
    epoch: u8,
    manifest_generation: u8,
    cbs_volatile: [bool; MAX_GENERATIONS],
    cbs_durable: [bool; MAX_GENERATIONS],
    flush_pending: [bool; MAX_GENERATIONS],
    flush_acked: [bool; MAX_GENERATIONS],
    s3_objects: [bool; MAX_GENERATIONS],
    s3_verified: [bool; MAX_GENERATIONS],
    put_attempted: [bool; MAX_GENERATIONS],
    head_absent_observed: [bool; MAX_GENERATIONS],
    cbs_reclaimed: [bool; MAX_GENERATIONS],
    observed_ambiguous_put: bool,
    recovered_ambiguous_put: bool,
    recovered_visibility_delay: bool,
    stale_epoch_rejected: bool,
    stale_epoch_mutated: bool,
}

impl Default for ProtocolState {
    fn default() -> Self {
        Self {
            running: true,
            epoch: 1,
            manifest_generation: 0,
            cbs_volatile: [false; MAX_GENERATIONS],
            cbs_durable: [false; MAX_GENERATIONS],
            flush_pending: [false; MAX_GENERATIONS],
            flush_acked: [false; MAX_GENERATIONS],
            s3_objects: [false; MAX_GENERATIONS],
            s3_verified: [false; MAX_GENERATIONS],
            put_attempted: [false; MAX_GENERATIONS],
            head_absent_observed: [false; MAX_GENERATIONS],
            cbs_reclaimed: [false; MAX_GENERATIONS],
            observed_ambiguous_put: false,
            recovered_ambiguous_put: false,
            recovered_visibility_delay: false,
            stale_epoch_rejected: false,
            stale_epoch_mutated: false,
        }
    }
}

impl ProtocolState {
    /// Returns whether the modeled service process is running.
    #[must_use]
    pub const fn is_running(&self) -> bool {
        self.running
    }

    /// Returns the active attachment epoch.
    #[must_use]
    pub const fn epoch(&self) -> u8 {
        self.epoch
    }

    /// Returns the newest published manifest generation.
    #[must_use]
    pub const fn manifest_generation(&self) -> u8 {
        self.manifest_generation
    }

    /// Counts generations whose only current or retained write copy is in CBS.
    #[must_use]
    pub fn dirty_generation_count(&self) -> usize {
        self.cbs_volatile
            .iter()
            .zip(self.cbs_durable)
            .filter(|(volatile, durable)| **volatile || *durable)
            .count()
    }

    /// Validates all production safety invariants without a model checker.
    #[must_use]
    pub fn invariant_violations(&self) -> Vec<&'static str> {
        let mut violations = Vec::new();
        if !self.flush_acknowledgments_are_durable() {
            violations.push(FLUSH_DURABLE);
        }
        if !self.manifest_is_complete() {
            violations.push(MANIFEST_COMPLETE);
        }
        if !self.reclamation_is_safe() {
            violations.push(RECLAIM_SAFE);
        }
        if !self.verification_is_sound() {
            violations.push(VERIFICATION_SOUND);
        }
        if self.dirty_generation_count() > DIRTY_GENERATION_LIMIT {
            violations.push(DIRTY_BOUNDED);
        }
        if self.stale_epoch_mutated {
            violations.push(EPOCH_FENCED);
        }
        violations
    }

    fn flush_acknowledgments_are_durable(&self) -> bool {
        generations().all(|generation| {
            let index = generation_index(generation);
            !self.flush_acked[index]
                || self.cbs_durable[index]
                || self.manifest_generation >= generation
        })
    }

    fn manifest_is_complete(&self) -> bool {
        generations().all(|generation| {
            generation > self.manifest_generation || self.s3_objects[generation_index(generation)]
        })
    }

    fn reclamation_is_safe(&self) -> bool {
        generations().all(|generation| {
            let index = generation_index(generation);
            !self.cbs_reclaimed[index]
                || (self.manifest_generation >= generation
                    && self.s3_objects[index]
                    && !self.cbs_durable[index]
                    && !self.cbs_volatile[index])
        })
    }

    fn verification_is_sound(&self) -> bool {
        generations().all(|generation| {
            let index = generation_index(generation);
            !self.s3_verified[index] || self.s3_objects[index]
        })
    }
}

/// Pure protocol configuration and transition function.
#[derive(Clone, Copy, Debug)]
pub struct Protocol {
    injected_fault: InjectedFault,
}

impl Protocol {
    /// Constructs the production protocol.
    #[must_use]
    pub const fn safe() -> Self {
        Self {
            injected_fault: InjectedFault::None,
        }
    }

    /// Constructs a deliberately broken protocol for checker self-tests.
    #[must_use]
    pub const fn with_fault(injected_fault: InjectedFault) -> Self {
        Self { injected_fault }
    }

    /// Enumerates every operation enabled in `state`, including failure outcomes.
    #[must_use]
    pub fn enabled_actions(&self, state: &ProtocolState) -> Vec<Action> {
        let mut actions = Vec::new();
        if !state.running {
            actions.push(Action::Recover);
            return actions;
        }

        let next_generation = state.manifest_generation.saturating_add(1);
        if usize::from(next_generation) <= MAX_GENERATIONS
            && state.dirty_generation_count() < DIRTY_GENERATION_LIMIT
        {
            let index = generation_index(next_generation);
            if !state.cbs_volatile[index]
                && !state.cbs_durable[index]
                && !state.cbs_reclaimed[index]
            {
                actions.push(Action::GuestWrite {
                    generation: next_generation,
                    epoch: state.epoch,
                });
            }
        }

        for generation in generations() {
            let index = generation_index(generation);
            if state.cbs_volatile[index] && !state.cbs_durable[index] {
                actions.push(Action::CbsSync { generation });
            }
            let may_ack_early =
                self.injected_fault == InjectedFault::AckBeforeCbsSync && state.cbs_volatile[index];
            if state.flush_pending[index]
                && !state.flush_acked[index]
                && (state.cbs_durable[index]
                    || state.manifest_generation >= generation
                    || may_ack_early)
            {
                actions.push(Action::AckFlush { generation });
            }
            if state.cbs_durable[index]
                && state.manifest_generation < generation
                && !state.s3_verified[index]
            {
                actions.push(Action::S3Put {
                    generation,
                    outcome: PutOutcome::Success,
                });
                actions.push(Action::S3Put {
                    generation,
                    outcome: PutOutcome::TimeoutAfterCommit,
                });
                if !state.put_attempted[index] {
                    actions.push(Action::S3Put {
                        generation,
                        outcome: PutOutcome::TimeoutBeforeCommit,
                    });
                }
            }
            if state.s3_objects[index] && !state.s3_verified[index] {
                actions.push(Action::S3HeadPresent { generation });
            }
            if state.put_attempted[index]
                && !state.s3_verified[index]
                && !state.head_absent_observed[index]
            {
                actions.push(Action::S3HeadAbsent { generation });
            }
            let may_commit_early =
                self.injected_fault == InjectedFault::CommitBeforeS3Put && state.cbs_durable[index];
            if generation == state.manifest_generation.saturating_add(1)
                && (state.s3_verified[index] || may_commit_early)
            {
                actions.push(Action::CommitManifest { generation });
            }
            let may_reclaim_early = self.injected_fault == InjectedFault::ReclaimBeforeManifest;
            if state.cbs_durable[index]
                && (state.manifest_generation >= generation || may_reclaim_early)
            {
                actions.push(Action::ReclaimCbs { generation });
            }
        }

        if state.epoch < MAX_EPOCH {
            actions.push(Action::Crash);
        }
        if state.epoch > 1 && !state.stale_epoch_rejected && !state.stale_epoch_mutated {
            actions.push(Action::StaleEpochWrite);
        }
        actions
    }

    /// Applies one enabled action and returns the next state.
    ///
    /// Returning `None` rejects a malformed or currently disabled operation.
    #[must_use]
    pub fn apply(&self, previous: &ProtocolState, action: Action) -> Option<ProtocolState> {
        if !self.enabled_actions(previous).contains(&action) {
            return None;
        }
        let mut state = previous.clone();
        match action {
            Action::GuestWrite { generation, epoch } => {
                if epoch != state.epoch {
                    return None;
                }
                let index = generation_index(generation);
                state.cbs_volatile[index] = true;
                state.flush_pending[index] = true;
            }
            Action::CbsSync { generation } => {
                state.cbs_durable[generation_index(generation)] = true;
            }
            Action::AckFlush { generation } => {
                let index = generation_index(generation);
                state.flush_pending[index] = false;
                state.flush_acked[index] = true;
            }
            Action::S3Put {
                generation,
                outcome,
            } => {
                let index = generation_index(generation);
                state.put_attempted[index] = true;
                match outcome {
                    PutOutcome::Success => {
                        state.s3_objects[index] = true;
                        state.s3_verified[index] = true;
                    }
                    PutOutcome::TimeoutAfterCommit => {
                        state.s3_objects[index] = true;
                        state.observed_ambiguous_put = true;
                    }
                    PutOutcome::TimeoutBeforeCommit => {}
                }
            }
            Action::S3HeadPresent { generation } => {
                let index = generation_index(generation);
                state.s3_verified[index] = true;
                if state.observed_ambiguous_put {
                    state.recovered_ambiguous_put = true;
                }
                if state.head_absent_observed[index] {
                    state.recovered_visibility_delay = true;
                }
            }
            Action::S3HeadAbsent { generation } => {
                state.head_absent_observed[generation_index(generation)] = true;
            }
            Action::CommitManifest { generation } => {
                state.manifest_generation = generation;
            }
            Action::ReclaimCbs { generation } => {
                let index = generation_index(generation);
                state.cbs_volatile[index] = false;
                state.cbs_durable[index] = false;
                state.cbs_reclaimed[index] = true;
            }
            Action::Crash => {
                state.running = false;
                state.cbs_volatile = [false; MAX_GENERATIONS];
                state.flush_pending = [false; MAX_GENERATIONS];
                state.s3_verified = [false; MAX_GENERATIONS];
                state.put_attempted = [false; MAX_GENERATIONS];
            }
            Action::Recover => {
                state.running = true;
                state.epoch = state.epoch.saturating_add(1);
            }
            Action::StaleEpochWrite => {
                if self.injected_fault == InjectedFault::AcceptStaleEpoch {
                    state.stale_epoch_mutated = true;
                } else {
                    state.stale_epoch_rejected = true;
                }
            }
        }
        Some(state)
    }
}

impl Model for Protocol {
    type State = ProtocolState;
    type Action = Action;

    fn init_states(&self) -> Vec<Self::State> {
        vec![ProtocolState::default()]
    }

    fn actions(&self, state: &Self::State, actions: &mut Vec<Self::Action>) {
        actions.extend(self.enabled_actions(state));
    }

    fn next_state(&self, state: &Self::State, action: Self::Action) -> Option<Self::State> {
        self.apply(state, action)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        match self.injected_fault {
            InjectedFault::AckBeforeCbsSync => {
                return vec![Property::<Self>::always(FLUSH_DURABLE, |_, state| {
                    state.flush_acknowledgments_are_durable()
                })];
            }
            InjectedFault::CommitBeforeS3Put => {
                return vec![Property::<Self>::always(MANIFEST_COMPLETE, |_, state| {
                    state.manifest_is_complete()
                })];
            }
            InjectedFault::ReclaimBeforeManifest => {
                return vec![Property::<Self>::always(RECLAIM_SAFE, |_, state| {
                    state.reclamation_is_safe()
                })];
            }
            InjectedFault::AcceptStaleEpoch => {
                return vec![Property::<Self>::always(EPOCH_FENCED, |_, state| {
                    !state.stale_epoch_mutated
                })];
            }
            InjectedFault::None => {}
        }

        vec![
            Property::<Self>::always(FLUSH_DURABLE, |_, state| {
                state.flush_acknowledgments_are_durable()
            }),
            Property::<Self>::always(MANIFEST_COMPLETE, |_, state| state.manifest_is_complete()),
            Property::<Self>::always(RECLAIM_SAFE, |_, state| state.reclamation_is_safe()),
            Property::<Self>::always(VERIFICATION_SOUND, |_, state| state.verification_is_sound()),
            Property::<Self>::always(DIRTY_BOUNDED, |_, state| {
                state.dirty_generation_count() <= DIRTY_GENERATION_LIMIT
            }),
            Property::<Self>::always(EPOCH_FENCED, |_, state| !state.stale_epoch_mutated),
            Property::<Self>::sometimes(TWO_GENERATIONS_COMMIT, |_, state| {
                usize::from(state.manifest_generation) == MAX_GENERATIONS
            }),
            Property::<Self>::sometimes(AMBIGUOUS_PUT_RECOVERS, |_, state| {
                state.recovered_ambiguous_put
            }),
            Property::<Self>::sometimes(S3_VISIBILITY_DELAY_RECOVERS, |_, state| {
                state.recovered_visibility_delay
            }),
            Property::<Self>::sometimes(CBS_CAN_RECLAIM, |_, state| {
                state.cbs_reclaimed.iter().all(|reclaimed| *reclaimed)
            }),
            Property::<Self>::sometimes(CRASH_CAN_RECOVER, |_, state| {
                state.running && state.epoch > 1
            }),
        ]
    }
}

fn generations() -> impl Iterator<Item = u8> {
    (1..=MAX_GENERATIONS).map(|generation| u8::try_from(generation).expect("small model"))
}

fn generation_index(generation: u8) -> usize {
    usize::from(generation - 1)
}

#[cfg(test)]
mod tests {
    use stateright::{Checker, Model};

    use super::{
        Action, EPOCH_FENCED, FLUSH_DURABLE, InjectedFault, MANIFEST_COMPLETE, Protocol,
        ProtocolState, RECLAIM_SAFE,
    };

    #[test]
    fn safe_protocol_exhaustively_satisfies_properties() {
        let checker = Protocol::safe().checker().spawn_bfs().join();
        assert!(checker.unique_state_count() > 100);
        checker.assert_properties();
    }

    #[test]
    fn checker_finds_ack_before_sync() {
        assert_counterexample(InjectedFault::AckBeforeCbsSync, FLUSH_DURABLE);
    }

    #[test]
    fn checker_finds_manifest_before_object() {
        assert_counterexample(InjectedFault::CommitBeforeS3Put, MANIFEST_COMPLETE);
    }

    #[test]
    fn checker_finds_reclaim_before_manifest() {
        assert_counterexample(InjectedFault::ReclaimBeforeManifest, RECLAIM_SAFE);
    }

    #[test]
    fn checker_finds_stale_epoch_write() {
        assert_counterexample(InjectedFault::AcceptStaleEpoch, EPOCH_FENCED);
    }

    #[test]
    fn malformed_action_is_rejected() {
        let state = ProtocolState::default();
        assert_eq!(
            Protocol::safe().apply(
                &state,
                Action::GuestWrite {
                    generation: 2,
                    epoch: 1,
                }
            ),
            None
        );
    }

    fn assert_counterexample(fault: InjectedFault, property: &'static str) {
        assert_eq!(fault.violated_property(), Some(property));
        let checker = Protocol::with_fault(fault).checker().spawn_bfs().join();
        let path = checker
            .discovery(property)
            .unwrap_or_else(|| panic!("checker did not find {fault:?}"));
        assert!(path.last_state().invariant_violations().contains(&property));
    }
}
