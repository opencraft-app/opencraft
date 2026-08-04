package schema

import (
	"testing"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
)

func TestServerSlugField固定业务和物理边界(t *testing.T) {
	value := serverSlugField("slug")
	descriptor := value.Descriptor()
	if descriptor.Size != 63 || descriptor.SchemaType[dialect.MySQL] != "varchar(63)" ||
		!descriptor.Immutable {
		t.Fatalf("slug descriptor = %#v", descriptor)
	}
	assertStringFieldAccepts(t, value, "agent-network")
	assertStringFieldRejects(t, value, "A-agent")
	assertStringFieldRejects(t, value, "a")
	assertStringFieldRejects(t, value, "agent_network")
}

func TestIMUserIDField固定业务和物理边界(t *testing.T) {
	value := immutableIMUserIDField("im_user_id")
	descriptor := value.Descriptor()
	if descriptor.Size != 32 || descriptor.SchemaType[dialect.MySQL] != "varchar(32)" ||
		!descriptor.Immutable {
		t.Fatalf("IM UserID descriptor = %#v", descriptor)
	}
	assertStringFieldAccepts(t, value, "a_AGENT_01")
	assertStringFieldRejects(t, value, "包含中文")
	assertStringFieldRejects(t, value, "123456789012345678901234567890123")
}

func assertStringFieldAccepts(t *testing.T, value ent.Field, input string) {
	t.Helper()
	for _, raw := range value.Descriptor().Validators {
		validator, ok := raw.(func(string) error)
		if !ok {
			t.Fatalf("字段 validator 类型 = %T", raw)
		}
		if err := validator(input); err != nil {
			t.Fatalf("字段应接受 %q：%v", input, err)
		}
	}
}

func assertStringFieldRejects(t *testing.T, value ent.Field, input string) {
	t.Helper()
	for _, raw := range value.Descriptor().Validators {
		validator, ok := raw.(func(string) error)
		if !ok {
			t.Fatalf("字段 validator 类型 = %T", raw)
		}
		if err := validator(input); err != nil {
			return
		}
	}
	t.Fatalf("字段不应接受 %q", input)
}
