# Findings

The copied text helpers alone left six mismatches: active Turn not cleared, fabricated historical completion, Item ID collisions, lost active reasoning on hydration, non-deterministic interruption/incorrect phase, overwritten start time. HyperNode owns an ordered Item ledger in TurnManager, and its engine settles visible Items before terminal lifecycle summaries. Its tool projection uses the same TurnManager and broadcasts notifications through a host port.
