//! Live warmed-QuickJS Actor-turn conformance on the designated PVM host.

#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

use minisandbox_core::{
    engine::{Engine, EngineError, RunOutcome},
    program::Program,
};

const DEPLOYMENT: &[u8] = br#"
globalThis.actorState = { count: 40, marker: "initialized-once" };
globalThis.handle = (input) => {
  actorState.count += input.delta;
  return { count: actorState.count, marker: actorState.marker };
};
"#;
const TURNS: usize = 32;

fn quickjs_guest() -> Program {
    let bytes = std::fs::read(env!("MINISANDBOX_QUICKJS_GUEST"))
        .expect("the conformance build produced a static QuickJS guest");
    Program::parse_elf(&bytes).expect("the static QuickJS guest satisfies the ELF contract")
}

#[test]
fn warmed_quickjs_template_runs_isolated_actor_turns() {
    let engine = Engine::open().expect("the designated host exposes PVM");
    let program = quickjs_guest();
    let warm_started = std::time::Instant::now();
    let template = engine
        .warm_actor_template(&program, DEPLOYMENT)
        .expect("QuickJS initializes and deployment code reaches the checkpoint");
    let warm_elapsed = warm_started.elapsed();

    assert!(template.is_actor_template());
    assert!(template.cow_page_count() > 100);
    assert_eq!(template.live_private_data_pages(), 0);

    let turns_started = std::time::Instant::now();
    let mut max_dirty_pages = 0;
    for _ in 0..TURNS {
        let mut turn = engine
            .fork_template(&template)
            .expect("each Actor turn gets a private PVM child");
        let result = turn
            .run_turn(br#"{"delta":2}"#)
            .expect("the warmed QuickJS child executes one bounded turn");
        assert_eq!(result.outcome, RunOutcome::Exited { code: 0 });
        assert_eq!(
            result.output,
            br#"{"count":42,"marker":"initialized-once"}"#
        );
        assert!(turn.stats().dirty_data_pages > 0);
        assert!(turn.stats().cow_faults > 0);
        assert_eq!(turn.stats().dirty_data_pages, turn.stats().cow_faults);
        assert!(turn.stats().dirty_data_pages <= 64);
        max_dirty_pages = max_dirty_pages.max(turn.stats().dirty_data_pages);
        assert!(matches!(
            turn.run_turn(br#"{"delta":1}"#),
            Err(EngineError::InstanceAlreadyRun)
        ));
        drop(turn);
        assert_eq!(template.live_private_data_pages(), 0);
    }
    eprintln!(
        "QuickJS warm={warm_elapsed:?} {TURNS}-turn elapsed={:?} max_dirty_pages={max_dirty_pages}",
        turns_started.elapsed()
    );
}
