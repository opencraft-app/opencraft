# Local runtime cold tier

This component runs one persistent S3 protocol double in Hub cluster C. Depot in runtime Cells A
and B reaches it through a private k3d-network NodePort. The two Cells use separate buckets, while
the service shares one PVC only as an implementation detail.

The double implements Depot's exact `PUT`, `GET`, `HEAD`, exact-key `DELETE`, and sorted paginated
`ListObjectsV2` inventory subset. Object keys
are immutable, payloads are verified against persisted SHA-256 metadata on every read, and writes
use fsync plus atomic links. Its local-only, token-protected admin endpoints provide bounded failure
and corruption injection for qualification. Engine and user workloads never receive that token. It
is not a production object store.

```sh
infra/cells/deploy/local/runtime-cold-tier/up.sh
infra/cells/deploy/local/runtime-cold-tier/verify.sh
infra/cells/deploy/local/runtime-cold-tier/down.sh
```
