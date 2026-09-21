# Strong TypeScript architecture

HyperNode policy currently executes as one QuickJS bundle and uses Cordis for
runtime composition.  Cordis already gives us hot replacement and scoped
dependency injection; TypeScript must add compile-time contracts without
turning those services back into a monolith.

## Architectural rule

The dependency direction is:

```text
host ABI / transport
        ↓
workspace + engine ports
        ↓
canonical execution facts
        ↓
AppServer / Paseo projections
        ↓
SSH, direct WebSocket, Desktop compatibility
```

An outer layer may depend on an inner port.  Canonical facts may not import a
Desktop projection, an engine-specific transcript, or an SSH connection.
Codex and DSH are peer engine adapters.  Neither owns the Thread identity or
the canonical timeline.

## Type boundaries

- IDs are branded (`ThreadId`, `TurnId`, `ItemId`, `ViewId`, `RuntimeId`) so a
  valid string cannot be wired into the wrong protocol field by accident.
- Engine selection is the closed union `"codex" | "dsh"`.
- Host capabilities are declared once in `types/host-abi.d.ts`; policy code
  must not invent ad-hoc `globalThis.host*` shapes.
- SQLite is accessed through a typed `DurableStoragePort` and typed result
  rows.  External JSON and protocol input enter as `unknown`, then cross a
  parser/validator before becoming domain values.
- Every migrated Cordis service exposes a small public port in the service
  catalog and types its constructor against exactly its declared injection
  keys.

## Migration sequence

1. Establish strict `tsc --noEmit` as a required build gate and type the host
   storage ABI, IDs, runtime registry, engine binding, and workspace operation
   journal.
2. Convert the canonical timeline and define its event union.  Exhaustive
   switches must reject unknown internal events; compatibility adapters retain
   `unknown` only at their ingress.
3. Introduce typed `EngineAdapter` and `WorkspaceDriver` ports, then convert
   DSH and Codex adapters independently.
4. Convert AppServer/Paseo projections.  Projections consume canonical events
   and never become persistence input.
5. Split `transparent-codex-thread.js` and `main.js` into composition and
   compatibility services, then remove `allowJs` from the policy tsconfig.

The generated `policy/default.js` remains the deployable QuickJS artifact.
Source authority moves to `.ts`; checked-in generated JavaScript is never an
API or a persistence format.

## Non-negotiable gates

- `npm run check:types` passes with strict mode, unchecked indexed access, and
  exact optional properties.
- The same gate rejects explicit `any`, TypeScript suppression directives, and
  double assertions from `unknown`; these cannot be hidden in code review.
- Existing protocol and browser/SSH tests continue to run against the bundle.
- No `@ts-ignore`, `@ts-nocheck`, or broad `any` is permitted in migrated
  modules.
- A service migration is complete only when its Cordis dependencies, host
  boundary, durable rows, public return values, and tests are typed.
- The final state has no JavaScript under `policy/src`; `allowJs` is a temporary
  bridge for unconverted modules, not the target architecture.
