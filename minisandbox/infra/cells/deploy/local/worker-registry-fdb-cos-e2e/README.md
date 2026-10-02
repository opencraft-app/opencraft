# Worker Registry FDB/COS integration gate

`run.sh` deploys two Registry replicas into local runtime A, connects them to
the real three-process FoundationDB cluster, and uses a protocol-level COS
double that enforces conditional immutable PUT and COS CRC64 responses.

The gate proves concurrent idempotent upload, six immutable versions, a five-Version deployable
window, rejection of an expired rollback, immutable Deployment history, Registry Pod replacement,
FDB recovery, report-only GC candidate classification, deletion of only the active pointer, and
continued loading of an old immutable version. It uses
an isolated FDB key prefix and removes its temporary Kubernetes namespace.
It also installs and removes one exact NetworkPolicy that grants the temporary
namespace TCP/4501 access; the Cell's default policy otherwise correctly
rejects cross-namespace FDB clients.

It does not replace the Tencent COS release qualification; that separate gate
must use a real private COS endpoint and scoped production-shaped credentials.

```sh
./run.sh
```
