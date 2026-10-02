#!/usr/bin/env bash
set -euo pipefail

upper=${RIVET_MINISANDBOX_UPPER:?RIVET_MINISANDBOX_UPPER is required}
upper_size_mib=${RIVET_MINISANDBOX_UPPER_SIZE_MIB:-2048}
block_pool=${RIVET_MINISANDBOX_BLOCK_POOL:?RIVET_MINISANDBOX_BLOCK_POOL is required}
actor_volume_mib=${RIVET_MINISANDBOX_ACTOR_VOLUME_MIB:-0}

[[ ${upper_size_mib} =~ ^[0-9]+$ ]] && ((upper_size_mib >= 64)) || {
	printf 'invalid RIVET_MINISANDBOX_UPPER_SIZE_MIB: %s\n' "${upper_size_mib}" >&2
	exit 1
}
upper_journal_mib=$((upper_size_mib / 64))
((upper_journal_mib >= 4)) || upper_journal_mib=4
((upper_journal_mib <= 32)) || upper_journal_mib=32
[[ -c /dev/kvm ]] || {
	printf '/dev/kvm is not a character device\n' >&2
	exit 1
}
for artifact in \
	"${RIVET_MINISANDBOX_KERNEL:?RIVET_MINISANDBOX_KERNEL is required}" \
	"${RIVET_MINISANDBOX_BASE_EROFS:?RIVET_MINISANDBOX_BASE_EROFS is required}" \
	"${RIVET_MINISANDBOX_APP_EROFS:?RIVET_MINISANDBOX_APP_EROFS is required}"; do
	[[ -r ${artifact} && -f ${artifact} ]] || {
		printf 'immutable minisandbox artifact is missing: %s\n' "${artifact}" >&2
		exit 1
	}
done

umask 0077
mkdir -p -- "$(dirname -- "${upper}")" "${block_pool}"
if ((actor_volume_mib > 0)); then
	actor_volume_template=${RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE:?RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE is required}
	actor_volume_template_gzip=${RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_GZIP:?RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_GZIP is required}
	actor_volume_template_sha256=${RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_SHA256:?RIVET_MINISANDBOX_ACTOR_VOLUME_TEMPLATE_SHA256 is required}
	actor_volume_template_stamp=${actor_volume_template}.sha256
	mkdir -p -- "$(dirname -- "${actor_volume_template}")"
	if [[ ! -f ${actor_volume_template} || ! -f ${actor_volume_template_stamp} ]] ||
		[[ $(<"${actor_volume_template_stamp}") != "${actor_volume_template_sha256}" ]] ||
		[[ $(stat -c %s -- "${actor_volume_template}" 2>/dev/null || true) != $((actor_volume_mib * 1024 * 1024)) ]]; then
		temporary_template=${actor_volume_template}.tmp-$$
		temporary_stamp=${actor_volume_template_stamp}.tmp-$$
		trap 'rm -f -- "${temporary_template}" "${temporary_stamp}"' EXIT
		gzip -dc -- "${actor_volume_template_gzip}" |
			dd of="${temporary_template}" bs=1M conv=sparse status=none
		echo "${actor_volume_template_sha256}  ${temporary_template}" |
			sha256sum --check --strict
		printf '%s\n' "${actor_volume_template_sha256}" >"${temporary_stamp}"
		mv -- "${temporary_template}" "${actor_volume_template}"
		mv -- "${temporary_stamp}" "${actor_volume_template_stamp}"
		trap - EXIT
	fi
fi
if [[ ! -f ${upper} ]]; then
	temporary=${upper}.tmp-$$
	staging=${upper}.staging-$$
	trap 'rm -rf -- "${staging}"; rm -f -- "${temporary}"' EXIT
	mkdir -p -- "${staging}/upper" "${staging}/work"
	chmod 0755 "${staging}" "${staging}/upper" "${staging}/work"
	truncate -s "${upper_size_mib}M" "${temporary}"
	mkfs.ext4 -F -q -d "${staging}" \
		-m 0 -b 4096 -J "size=${upper_journal_mib}" \
		-E lazy_itable_init=0,lazy_journal_init=0,assume_storage_prezeroed=1 \
		-O sparse_super2,^64bit,^resize_inode \
		-U 00000000-0000-0000-0000-000000000001 -L msandbox-upper "${temporary}"
	mv -- "${temporary}" "${upper}"
	rm -rf -- "${staging}"
	trap - EXIT
fi

exec /opt/minisandbox/bin/sbxlet "$@"
