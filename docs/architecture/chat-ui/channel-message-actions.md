# Message and attachment actions

Native Inbox messages use the shared context menu: mouse right-click, keyboard
context-menu key/Shift+F10 and touch long-press. Reply and rich-text copy retain
the shared document owner. Ordinary text, pictures and files may be explicitly
forwarded into an existing writable conversation after destination confirmation.
The destination members can then read that independent message/attachment. A
forward does not carry reply IDs, mention targets or Bot wake grants from its source.

The retained conversation, not a recycled timeline row, owns the action lifetime
and one send key per destination across failures. Source reads and target sends
use the existing authenticated channel client; there are no public filesystem
paths or bearer attachment links. Leaving the account cancels late reads. Drafts
are not used as a transient transfer buffer and are not changed by forwarding.
Accepted local admission is distinct from external-provider delivery confirmation.

Download/share transfer original bytes. Image clipboard writes are initiated in
the local user gesture and use a promised PNG representation; unsupported formats,
clipboard refusal and unavailable files never produce a success notice. Generic
files do not pretend to be copied when only their names can enter the system
clipboard. Native file sharing is offered only by capable browsers, with download
as fallback. Structured chat archives with source-scoped nested resources are not
forwarded as misleading detached JSON attachments.

The native file boundary is20MiB, matching the installation file transport bound.
Upload and read RPCs remain64KiB-chunked. An installation may explicitly declare
generic-file delivery for a source through CommunicationExtension.channelFiles;
a binding alone does not claim file support. The outbox transports only attachment
metadata in its claim, then reads each chunk under the original sender generation,
credential, membership epoch and source incarnation. Unsupported transports reject
visibly. Unknown provider effects are never automatically resent after restart.
No SQLite migration or public RPC shape change is needed.
