package runtimeactor

import "strings"

const localOnlyLaunchPrefix = "local_legacy_"

func isLocalOnlyLaunchID(value string) bool {
	return strings.HasPrefix(value, localOnlyLaunchPrefix)
}
