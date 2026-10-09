package physicalschema

import "testing"

func TestBaselineCatalog不随ComputerEnrollment字段改写(t *testing.T) {
	baseline, err := Baseline20260801000000()
	if err != nil {
		t.Fatal(err)
	}
	current, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	oldComputer, ok := baseline.Table("computers")
	if !ok {
		t.Fatal("baseline 缺少 computers")
	}
	newComputer, ok := current.Table("computers")
	if !ok {
		t.Fatal("current 缺少 computers")
	}
	if len(newComputer.Desired.Columns) <= len(oldComputer.Desired.Columns) {
		t.Fatalf("current columns=%d baseline columns=%d", len(newComputer.Desired.Columns), len(oldComputer.Desired.Columns))
	}
	if _, ok := oldComputer.Desired.Column("enrollment_generation"); ok {
		t.Fatal("published baseline 不应包含后续的 enrollment 字段")
	}
	if _, ok := newComputer.Desired.Column("enrollment_generation"); !ok {
		t.Fatal("current catalog 应包含 enrollment 字段")
	}
}

func TestBaselineCatalog不随Reminder锚点字段改写(t *testing.T) {
	baseline, err := Baseline20260801000000()
	if err != nil {
		t.Fatal(err)
	}
	current, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	oldReminder, ok := baseline.Table("reminders")
	if !ok {
		t.Fatal("baseline 缺少 reminders")
	}
	newReminder, ok := current.Table("reminders")
	if !ok {
		t.Fatal("current 缺少 reminders")
	}
	for _, name := range []string{
		"anchor_kind", "anchor_channel_id", "anchor_thread_id", "anchor_message_ref_json",
	} {
		if _, ok := oldReminder.Desired.Column(name); ok {
			t.Fatalf("published baseline 不应包含后续字段 %s", name)
		}
		if _, ok := newReminder.Desired.Column(name); !ok {
			t.Fatalf("current catalog 应包含字段 %s", name)
		}
	}
}

func TestBaselineCatalog不随活动Handle占用字段改写(t *testing.T) {
	baseline, err := Baseline20260801000000()
	if err != nil {
		t.Fatal(err)
	}
	current, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	oldMember, ok := baseline.Table("members")
	if !ok {
		t.Fatal("baseline 缺少 members")
	}
	newMember, ok := current.Table("members")
	if !ok {
		t.Fatal("current 缺少 members")
	}
	if _, ok := oldMember.Desired.Column("active_handle_key"); ok {
		t.Fatal("published baseline 不应包含活动 handle 占用字段")
	}
	if _, ok := newMember.Desired.Column("active_handle_key"); !ok {
		t.Fatal("current catalog 应包含活动 handle 占用字段")
	}
}
