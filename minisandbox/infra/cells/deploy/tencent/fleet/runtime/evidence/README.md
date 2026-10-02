# Beijing input-prefix runtime qualification, 2026-10-03

These are original, byte-preserved receipts for runtime source
`072e504bb9784e7d2d0b73def169e886a7f30e31`, image digest
`sha256:6e4d982e8ca66b8a7841c720143464927cb0f7c09d656f3c1fab1e189b07f3d2`.
They qualify the recorded production-cell Bottomless and one-Engine-loss
scenarios, not strict 10,000-active capacity or Router performance.

| File | Raw SHA-256 |
|---|---|
| `beijing-prefix-072e504b-a01-bottomless-20261003.json` | `7d0a9a347b5042b06e15d1bfe539c0957ccc7f76807b2ff1d246cba85dee2a17` |
| `beijing-prefix-072e504b-a01-engine-ha-20261003.json` | `d83a44e5202b41691a478759230fd2fc272fdbb914039bc6548bbfcd4dcb2906` |
| `beijing-prefix-072e504b-b01-bottomless-20261003.json` | `128b66e551eb2bd7ea0fcf58dcef08f4a755e9257af283021dc8da2ae94b3f9b` |
| `beijing-prefix-072e504b-b01-engine-ha-20261003.json` | `4deab0e58a47a593e146e72d2947cba2998f6253dd0207bfa61c1a120d903f6d` |

The builder receipt root for each Cell is
`/data/actor-bootstrap/beijing-rebuild-20260915/cells/<cell>/receipts/runtime-prefix-072e504bb9784e7d2d0b73def169e886a7f30e31-216296ad46ae77219cfa4f6b1eb2fa558124415344701cb77cf03dadccbea846/qualification/`.
A's original filenames were unsuffixed; its release wrapper failed receipt
discovery after both fault gates passed. Resume invocation `inv-e9dwwxgwkr`
added same-byte discoverable names and completed only governance/activation.
It did not repeat rollout or fault injection. B's original release invocation
`inv-e9dx3fg9p5` completed SUCCESS/0 including activation.

Both receipts retain 48-object exact cold-state checks. A/B cold-state waits
were about 973/964 seconds, and cold-wake p95 about 956/1,072 milliseconds.
These waits do not isolate a root cause or measure steady reclaim capacity.
Each HA receipt records 1,500 public requests and zero failures.

From the repository root, validate Bottomless with the existing verifier:

```sh
for cell in a01 b01; do
  python3 minisandbox/infra/cells/deploy/tencent/fleet/runtime/verify_bottomless_receipt.py \
    --profile production-cell --expected-cell "actor-bj-$cell" \
    --expected-namespace actor-fdb-cell-system \
    --expected-worker "$cell-bottomless-qualification" \
    "minisandbox/infra/cells/deploy/tencent/fleet/runtime/evidence/beijing-prefix-072e504b-$cell-bottomless-20261003.json"
done
```

`claim_eligible=false` is expected for these component receipts: qualification
publication requires composing the other production gates. HA's canonical
hash and semantic checks are defined in `../qualify-engine-ha.sh`; retain both
before/after release bindings, the exact removed Pod UID, the measured request
window containing fault injection, and successful Object cleanup.
