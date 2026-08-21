# SG Production Trade Resource Query Authentication Fix

## Problem

The SG production trade callbacks `lightvela.pass.getAllAppIds`,
`lightvela.pass.getUserResources`, and `lightvela.pass.queryResource` reach trade,
but trade receives HTTP 401 from CTL and returns business code `600202`.

SG trade sends `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`. Its value matches CTL's
`CTL_TRADE_TOKEN`, while SG CTL only exposes a different `CTL_INTERNAL_TOKEN` to
its inbound bearer check. The tkexsg production SG route still points to JP and
must remain there until all three callbacks pass against SG.

## Design

Repair the configuration contract without changing CTL application behavior:

1. Add `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` to the SG CTL runtime-secret contract.
2. Store the existing `CTL_TRADE_TOKEN` value under that key in a new immutable
   SSM version.
3. Regenerate the SG CTL runtime SOPS Secret through the standard exporter.
4. Release the CTL change through CI/GitOps and rerun all three callbacks.
5. Only after all three return business code `0`, change the tkexsg production
   SG callback override to `https://api.lightvela.ai` in a separate change.

`CTL_INTERNAL_TOKEN` remains unchanged so its existing consumers are unaffected.

## Verification

- The SSM manifest requires `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`.
- The generated SOPS Secret contains an encrypted value for the new key.
- Secret scanning and SG CTL contract tests pass.
- Live SG CTL receives the shared token after its GitOps rollout.
- All three resource-query callbacks return HTTP 200 and business code `0`.
- The SG route changes only after that live verification.

## Rollback

Point the manifest back to the previous immutable SSM version and revert the
secret release. The later route change can be reverted independently to the JP
sandbox endpoint.
