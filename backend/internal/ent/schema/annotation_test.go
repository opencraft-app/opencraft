package schema

import "testing"

func TestShardKeyAnnotation名称和字段稳定(t *testing.T) {
	annotation := ShardKey{Field: "server_id"}
	if got := annotation.Name(); got != "ChatserverShardKey" {
		t.Fatalf("Name() = %q，期望 ChatserverShardKey", got)
	}
	if annotation.Field != "server_id" {
		t.Fatalf("Field = %q，期望 server_id", annotation.Field)
	}
}
