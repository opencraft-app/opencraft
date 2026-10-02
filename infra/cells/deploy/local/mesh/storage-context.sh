#!/usr/bin/env bash

# Product installation always resolves one complete StorageProfile. Qualification
# jobs use isolated, disposable FDB/COS identities and must opt in explicitly so
# they can never be mistaken for a deployable Cell profile.
storage_context=${RIVET_LOCAL_STORAGE_CONTEXT:-profile}
case ${storage_context} in
	profile)
		# shellcheck source=storage-profile.sh
		source "${MESH_DIR}/storage-profile.sh"
		;;
	qualification)
		case ${RIVET_LOCAL_STORAGE_PROFILE_ID:-} in
			*qualification*) ;;
			*) die "qualification storage context requires an explicit qualification StorageProfile identity" ;;
		esac
		;;
	*) die "RIVET_LOCAL_STORAGE_CONTEXT must be profile or qualification" ;;
esac

export RIVET_LOCAL_STORAGE_CONTEXT=${storage_context}
