package schema

import (
	"testing"
	"time"
)

func TestIDMixin定义UUIDv7逻辑主键(t *testing.T) {
	fields := (IDMixin{}).Fields()
	if len(fields) != 1 {
		t.Fatalf("IDMixin.Fields() 数量 = %d，期望 1", len(fields))
	}
	desc := fields[0].Descriptor()
	if desc.Err != nil {
		t.Fatalf("ID 字段描述错误：%v", desc.Err)
	}
	if desc.Name != "id" || !desc.Immutable {
		t.Fatalf("ID 字段 = %#v，期望 name=id 且 immutable", desc)
	}
	defaultFunc, ok := desc.Default.(func() string)
	if !ok {
		t.Fatalf("ID Default 类型 = %T，期望 func() string", desc.Default)
	}
	value := defaultFunc()
	if len(value) != 36 || value[14] != '7' {
		t.Fatalf("ID Default() = %q，不是 UUIDv7", value)
	}
}

func Test时间字段统一UTC毫秒(t *testing.T) {
	created := CreatedAtField().Descriptor()
	if created.Name != "created_at" || created.Optional || created.Nillable {
		t.Fatalf("created_at 描述不符合要求：%#v", created)
	}
	createdDefault, ok := created.Default.(func() time.Time)
	if !ok {
		t.Fatalf("created_at Default 类型 = %T", created.Default)
	}
	assertUTCMillisecond(t, createdDefault())

	updated := UpdatedAtField().Descriptor()
	if updated.Name != "updated_at" || updated.Optional || updated.Nillable {
		t.Fatalf("updated_at 描述不符合要求：%#v", updated)
	}
	updatedDefault, ok := updated.Default.(func() time.Time)
	if !ok {
		t.Fatalf("updated_at Default 类型 = %T", updated.Default)
	}
	updateDefault, ok := updated.UpdateDefault.(func() time.Time)
	if !ok {
		t.Fatalf("updated_at UpdateDefault 类型 = %T", updated.UpdateDefault)
	}
	assertUTCMillisecond(t, updatedDefault())
	assertUTCMillisecond(t, updateDefault())
}

func assertUTCMillisecond(t *testing.T, value time.Time) {
	t.Helper()
	if value.Location() != time.UTC {
		t.Fatalf("时间 Location = %s，期望 UTC", value.Location())
	}
	if value.Nanosecond()%int(time.Millisecond) != 0 {
		t.Fatalf("时间 %s 未截断到毫秒", value)
	}
}
