#!/bin/sh
set -eu

# Keep the production Cargo profile unchanged while selecting the lower-memory
# LLVM linker on the small q01 qualification builder.
test -x /usr/bin/clang
test -x /usr/bin/ld.lld
exec /usr/bin/clang --ld-path=/usr/bin/ld.lld "$@"
