# vela-backends/tests/support

Backend test helpers live here.

This support layer may load raw provider fixtures and normalize them into `BackendOutput`, but it must not allocate canonical event cursors or assert HTTP daemon responses.
