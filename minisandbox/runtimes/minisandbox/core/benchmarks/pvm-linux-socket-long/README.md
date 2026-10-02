# PVM long-lived socket verification

This standalone workspace verifies the product ingress path with real protocol
clients rather than a framed synthetic transport:

- 16 HTTP/1.1 keep-alive connections, 64 sequential requests each;
- 16 SSE streams, 512 fixed 512-byte events each, with half the clients
  stopping all body reads until every other protocol client completes;
- 16 WebSocket connections, 64 masked 256-byte binary messages and echoes each.

The guest is one bounded C event loop using nonblocking sockets and
`EPOLLET`. It drains accept/read/write until `EAGAIN`, keeps only 8 KiB input
and 4 KiB output per connection, and requires observed send and receive
backpressure before passing. The host uses Hyper for HTTP/SSE and
Tokio-Tungstenite for WebSocket. Every connection is a private capability
injected into one warm COW clone; there is no host listener, TAP, TUN, or
network namespace.

The host retains one of eight admission permits until each connection reaches
its application handshake. An ingress ACK only proves that the kernel queued
the offer; releasing admission at ACK can fill the intentionally bounded guest
listener queue faster than the application calls `accept(2)`.

Build and run:

```text
./benchmarks/pvm-linux-socket-long/build-rootfs.sh
cargo run --locked --release \
  --manifest-path benchmarks/pvm-linux-socket-long/Cargo.toml -- \
  target/pvm-linux/build/arch/x86/boot/bzImage \
  benchmarks/pvm-linux-socket-long/build/debian-socket-long.erofs
```

A passing run prints `accepted=48 completed=48` and nonzero `send_eagain` and
`recv_eagain` counters. The exact EAGAIN counts are scheduler-dependent.

Generated binaries, EROFS images, and Cargo outputs remain below this folder's
ignored `build/` and `target/` directories.
