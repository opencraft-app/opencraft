# Minisandbox runtime

Minisandbox is split by trust boundary and build lifecycle:

| Path | Responsibility |
| --- | --- |
| [`core/`](core/README.md) | PVM runtime, Linux guest, bounded device parsers, networking and control protocol |
| [`storage/`](storage/README.md) | ActorVolume algorithms, reference backends, models and validation frontends |
| [`host/`](host/) | Rivet Envoy lifecycle and HTTP adapter |
| [`sbxlet/`](sbxlet/README.md) | Profile ownership, warm template admission and standalone execution host |

`core` and `storage` intentionally remain separate Cargo workspaces. The PVM attack surface depends
on the narrow typed block backend; storage metadata, COS behavior, model checking, and NBD validation
do not become guest-facing device parsers.
