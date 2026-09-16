package physicalschema

import (
	"slices"
	"testing"
)

func TestDirectConversationUsesServerShardAndCanonicalMemberPair(t *testing.T) {
	t.Parallel()

	catalog, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	table, ok := catalog.Table("direct_conversations")
	if !ok {
		t.Fatal("direct_conversations is missing from physical schema")
	}
	if table.Schema != "DirectConversation" {
		t.Errorf("schema = %q, want DirectConversation", table.Schema)
	}
	if table.ShardKey != "server_id" {
		t.Errorf("shardkey = %q, want server_id", table.ShardKey)
	}
	if !slices.Equal(table.PhysicalPrimaryKey, []string{"server_id", "id"}) {
		t.Errorf("physical primary key = %v", table.PhysicalPrimaryKey)
	}

	for _, name := range []string{"member_a_id", "member_b_id", "im_group_id", "status", "im_state", "revision"} {
		column, exists := table.Desired.Column(name)
		if !exists {
			t.Errorf("column %s is missing", name)
			continue
		}
		if column.Nullable {
			t.Errorf("column %s must not be nullable", name)
		}
	}

	foundPair := false
	for _, index := range table.Desired.Indexes {
		if index.Unique && slices.Equal(columnNames(index.Columns), []string{"server_id", "member_a_id", "member_b_id"}) {
			foundPair = true
			break
		}
	}
	if !foundPair {
		t.Error("canonical member pair unique index is missing")
	}
}
