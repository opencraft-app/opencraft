#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
seeds=${SOAK_SEEDS:-"0x0000000000000001 0x9e3779b97f4a7c15 0xdeadbeefcafebabe 0x0123456789abcdef 0xffffffffffffffff"}
ops=${SOAK_OPS:-128}
reload_every=${SOAK_RELOAD_EVERY:-7}

for seed in $seeds; do
	echo "running Depot/VFS chaos seed=$seed ops=$ops reload_every=$reload_every"
	docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
		-e "RIVET_CHAOS_SEED=$seed" \
		-e "RIVET_CHAOS_OPS=$ops" \
		-e "RIVET_CHAOS_RELOAD_EVERY=$reload_every" \
		qualify \
		cargo test -p rivet-depot-client \
		vfs::tests::fault::chaos::chaos_replay_from_env -- \
		--ignored --exact --test-threads=1
done

echo "all seeded Depot/VFS chaos replays passed"
