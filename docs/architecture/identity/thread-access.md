# Conversation access

The Hub owns persisted conversation access in the shared `opencraft-server.sqlite` database (the `thread_access` and `thread_access_audit` tables). A policy is keyed by server and thread, records the immutable human creator, shared/private mode and a monotonic revision. Presentation visibility, filesystem permissions and derived conversations are separate concerns.

Only the authenticated creator can change the policy with an expected revision. Private conversations are readable only by that creator through application interfaces. Participation, instance administration and pre-existing conversation grants do not override privacy. Explicit execution delegation continues to use the initiating human authority; unrelated agents cannot discover private resources.

The AppHost installs one access session per logical lease. It checks requests before forwarding and responses again before delivery, filters directory/search/pinned/loaded results, and removes protected metadata from structured references. Native process ownership and internal service calls remain separate trusted ports; collaboration rechecks its own originating actor against the same policy. The direct AppServer bridge uses the same access session. Push delivery rechecks access before notification transmission.

`opencraft/thread-access/read` returns the access mode, revision and server-computed `canChangeAccess`. `opencraft/thread-access/set` accepts threadId, accessMode and expectedRevision. Mutations and audit rows commit together. Unknown historical creators cannot claim a resource. A trusted product adapter may recover a historical creator only from verified persisted creation provenance, bound to the current human identity.

Revocation stops future delivery and removes current client views and catalog caches. It cannot recover information already read or copied. A newly private parent does not change children or forks. Generic filesystem tools and independent file URLs are not covered by this application-level policy.
