# Findings

## Current OpenCraft strengths

- Already defines 39 motion states, 18 identity shapes, and the same 14 effect names.
- Conversation surface is the sole owner of live projection.
- One hidden animated SVG source per participant is mirrored into flow-owned marks.
- Pointer input is shared at the Stage rather than registered per visible mark.
- Reduced-motion handling and deterministic seeded behavior already exist.

## Reference strengths worth adapting

- Explicit simulation clock and fixed-step spring integration.
- Separate behavior, physics, morph, particle, material, geometry, and SVG-renderer systems.
- Shape-aware eye fitting and continuous path interpolation.
- One-shot morph lifecycle: RESET, ENTER, HOLD, EXIT, DONE.
- IntersectionObserver pause, lifecycle cleanup, and exhaustive transition tests.
- Material definitions update only when their signature changes.

## Reference risks

- The repository says geometry and behavioral data are reference-derived and grants no open-source license for third-party reference assets.
- SVG bounds are read during render and pointer updates; this can force repeated layout work.
- Each custom element owns an animation loop; that scales poorly for multi-Bot chat.
- The particle system can maintain more than 100 particles and dynamically create paths and gradients.
- Complex glass and animated path geometry are paint-heavy for small, repeated avatars.
- Animalese/dialogue direction is not a natural default for a professional agent workbench.

## Main gap

OpenCraft does not primarily lack states or shapes. It lacks a modular animation runtime with explicit one-shot effect lifecycles, shape-aware geometry interpolation, bounded material projection, shared scheduling, and exhaustive transition/performance tests.
