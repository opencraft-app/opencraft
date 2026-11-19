# Recover a failed execution environment without waiting for idle

OpenCraft observes execution availability separately from AppServer connectivity and owns recovery for the AppServer instances whose lifecycle it manages. A confirmed execution failure uses Codex's supported recovery capability when available; otherwise OpenCraft restarts the affected instance without waiting for its conversations or background work to become idle. Applying ordinary maintenance drain to an already failed executor can indefinitely prevent recovery.

Failed recovery continues with backoff. New inputs remain in the existing persistent queue while execution is unavailable. Previously dispatched work retains its interrupted or delivery-unknown outcome and is never automatically replayed. This trades interruption of the failed instance's remaining work for restoring execution; it does not change normal upgrade drain or grant lifecycle authority over attach-only external servers.

Codex retains ownership of its executor implementation. Restoring service does not establish the cause of its original failure; OpenCraft records lifecycle observations so that cause can be investigated independently.
