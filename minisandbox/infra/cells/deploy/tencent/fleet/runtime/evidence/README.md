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

## Bounded point-read runtime qualification

The `beijing-point-read-c631f554-{a01,b01}-*.json` files preserve the original
receipts for source `c631f5542f45b974455543d5bb458e0b3b3cf395`, source manifest
`a54e7daa59d1b1a48403d6766a866486630b2cb7d1187a1e0d2a4427eb82bd0c`, and image
`sha256:d3a6e41e3d1c4726998f8261d3b75648249df4a60d26a948820d28067a797711`.
The product receipt SHA is
`d49da48b0ec04edd39bd53252910a20e2cbaa4c44930f92fd1a89bef44685cb1`.
Source-manifest identity is distinct from each rendered Cell manifest.

| Cell / receipt | Raw SHA-256 |
|---|---|
| A / bottomless | `922a7cba934ae50db81907b02395e508d25c89cf538aada41c73fa9882fa83d3` |
| A / engine-ha | `bcf821139d7159c3a9c1b0842f8ccb1cacfe710ff0e8cf7a156fda2eccd3c07c` |
| A / activation | `0858168f3607ea610924a3070aedd4042c0cb1da8fcc8c220c345796e3547f29` |
| A / control | `130f41068e982dcf92c09075a1616e98f538f75e6a39abb78325dfae6b45692d` |
| A / audit | `9b100d943e11a9992d9e46002ebb96e8b62a67f1e78948e9127e686b492f286a` |
| B / bottomless | `9c93cf5aaf8877172c2f6c51aba4a7b46b64dcd0894500741e33c95808580503` |
| B / engine-ha | `112e070be321ca70d4afa11e0883af06f1d2229697a3df4aa6e3d7701ae128df` |
| B / activation | `3d56b06cca85221c0bd028e851b3a14390b321295f94b172ad4a490e148f9809` |
| B / control | `5ab7068bfa1f02252b7c174ddee62590e22e50d9daf1782cbdf557addd6c793e` |
| B / audit | `a09dd5b3927e71c304c0c0ce47008e0279c52923310e63f062e922826d999e55` |

A's original invocation `inv-a9ep2a0399` ended SUCCESS/0 at 08:36:16 UTC;
B's `inv-d9epts0437` ended SUCCESS/0 at 09:29:08 UTC on 2026-10-03.
Both verify 48 Objects, 6,240 writes, exact cold state, and 1,500 public
requests with zero failures during one-Engine loss. B's cold-state wait was
2,450,858.673 ms; cold-wake p95/p99 were 1,109.164/2,320.084 ms.
The long cold-state wait has not been causally attributed. It is not a COS
request-latency measurement or evidence of strict 10,000-active capacity.

Use the same verifier command above, replacing `beijing-prefix-072e504b` with
`beijing-point-read-c631f554`. `claim_eligible=false` remains expected.
Keep the original audit's non-standard Infinity values and exact byte hash;
do not rewrite archived evidence to make it satisfy a strict JSON parser.
Activation references the exact control receipt, which references the exact
audit. Live original Cell UIDs were independently checked Ready before the
new strict workload. The new run's source, tools, live identity and eventual
capacity verdict remain separate evidence in the load directory.
