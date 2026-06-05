package redis

import "strings"

type redisKeyspace struct {
	prefix string
}

func newRedisKeyspace(prefix string) redisKeyspace {
	return redisKeyspace{prefix: prefix}
}

func (k redisKeyspace) key(parts ...string) string {
	out := k.prefix
	for _, part := range parts {
		out += part
	}
	return out
}

func (k redisKeyspace) runtimeOwnership(sessionID string) string {
	return k.key("rt-own:", sessionID)
}

func (k redisKeyspace) runtimeEnsureLock(lockKey string) string {
	return k.key("rt-lock:", lockKey)
}

func (k redisKeyspace) workspaceLease(workspaceID string) string {
	return k.key("ws:{", redisHashTag(workspaceID), "}:lease")
}

func (k redisKeyspace) workspaceFence(workspaceID string) string {
	return k.key("ws:{", redisHashTag(workspaceID), "}:fence")
}

func (k redisKeyspace) workspaceAcquireLeaseKeys(workspaceID string) []string {
	return []string{k.workspaceLease(workspaceID), k.workspaceFence(workspaceID)}
}

func redisHashTag(value string) string {
	return strings.NewReplacer("{", "_", "}", "_").Replace(value)
}
