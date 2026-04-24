package objectid

import (
	"strings"
	"testing"

	"ctl/pkg/logic/objectid"
)

func TestGenerateObjectId(t *testing.T) {
	l := objectid.NewLogic()
	seen := make(map[string]bool)
	for i := 0; i < 10; i++ {
		id := l.GenerateTaskId()
		t.Log(i, "task", id)
		if !strings.HasPrefix(id, "task-") {
			t.Errorf("expected prefix 'task-', got %s", id)
		}
		if seen[id] {
			t.Errorf("duplicate id: %s", id)
		}
		seen[id] = true
	}

	insId := l.GenerateInstanceId()
	if !strings.HasPrefix(insId, "ins-") {
		t.Errorf("expected prefix 'ins-', got %s", insId)
	}
	t.Log("instance", insId)

	opId := l.GenerateOperationId()
	if !strings.HasPrefix(opId, "op-") {
		t.Errorf("expected prefix 'op-', got %s", opId)
	}
	t.Log("operation", opId)

	wxId := l.GenerateWxLoginSessionId()
	if !strings.HasPrefix(wxId, "wxs-") {
		t.Errorf("expected prefix 'wxs-', got %s", wxId)
	}
	t.Log("wxlogin", wxId)
}
