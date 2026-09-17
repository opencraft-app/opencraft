# OpenCraft Bot animation upgrade analysis

## Goal

Determine which ideas from `grokbot-animation` should upgrade OpenCraft's Bot avatar system without changing protocol ownership, copying restricted reference assets, or regressing multi-Bot performance.

## Phases

- [x] Establish reference and current implementation baselines.
- [x] Compare state, geometry, runtime, material, effect, lifecycle, accessibility, and test ownership.
- [x] Identify adoption constraints and performance hazards.
- [x] Produce a phased target architecture and acceptance gates.
- [x] Implement the shared Stage scheduler and separated runtime systems.
- [x] Implement sampled geometry, shape-aware eyes, and explicit effect lifecycle.
- [x] Implement bounded materials and multi-Bot scheduling.
- [x] Complete focused, boundary, type, and browser verification.

## Non-goals

- No copying of reference-derived geometry or third-party assets.
- No new AppServer animation protocol.
- No audio personality feature in the default product experience.

## Decisions

- Preserve OpenCraft's conversation-owned Stage and source/mirror topology.
- Treat semantic Presence as authority; animation state remains a renderer projection.
- Borrow runtime contracts and test strategy, not reference-derived visual data.
- Use one scheduler for visible live sources and cached measurements rather than one independent hot loop per rendered mark.

## Errors encountered

- A path was accidentally doubled while checking the reference license; reran from the clone root with correct relative paths.
- Graphify was explicitly rejected by the user; its generated cache files were deleted and it is not part of this analysis.
