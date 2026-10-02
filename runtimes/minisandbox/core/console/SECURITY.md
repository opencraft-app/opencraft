# Console security boundary

This directory is not a production service boundary.

- No UDS/TCP listener, JSON parser, or guest-selected host path is created.
  Outbound host sockets exist only inside the capability-backed socket broker.
- `pvm-console-device` owns only scalar registers and one fixed 64-byte array.
  Guest port accesses cannot allocate memory or select an interrupt number.
- Host input is copied only through `PvmMachine::queue_console_input`; a full
  FIFO rejects the suffix and records a UART overrun.
- The adapter can assert only the already existing COM1 IRQ4 line.
- A Linux checkpoint is rejected while unread console input exists, preventing
  one input stream from being duplicated into multiple COW clones.
- The runner starts the separately audited socket broker with `AllowAll` for
  outbound TCP and DNS resolver selection. The transport remains bounded to
  TCP streams and validated UDP/53 DNS; no arbitrary UDP, raw socket, inbound
  listener, or host descriptor is exposed. This unrestricted destination
  policy is intentionally a development-console choice.

Deleting `console/runner`, removing the workspace entries, and reverting the
small UART adapter dependency removes the experiment. No console protocol is a
stable minisandbox ABI.
