package wrapper

import "testing"

func TestApplyWorkspaceRecordRestoresInnerWorkspacePair(t *testing.T) {
	runtime := ACPSessionRuntime{
		OuterRuntime: outerRuntimeWisp,
	}
	rec := WorkspaceRecord{
		WorkspaceID:        "workspace_stable",
		WispName:           "outer-wisp",
		WispSMHSpaceID:     "outer-space",
		WorkspaceWispName:  "inner-wisp",
		WorkspaceRuntimeID: "inner-runtime",
		WorkspaceVersion:   "builtin.v1",
	}

	got := applyWorkspaceRecordToRuntime(runtime, rec)
	if got.WorkspaceID != "workspace_stable" {
		t.Fatalf("workspace id should be restored from workspace record, got %q", got.WorkspaceID)
	}
	if got.WorkspaceWispName != "inner-wisp" {
		t.Fatalf("inner workspace Wisp name should be restored, got %q", got.WorkspaceWispName)
	}
	if got.WorkspaceRuntimeID != "inner-runtime" {
		t.Fatalf("inner workspace runtime id should be restored, got %q", got.WorkspaceRuntimeID)
	}
}
