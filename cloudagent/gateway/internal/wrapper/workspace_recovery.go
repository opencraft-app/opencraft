package wrapper

import (
	"context"
	"strings"
)

type workspaceRecoverySnapshot struct {
	Runtime             ACPSessionRuntime
	Restorable          bool
	WorkspacePersistent bool
	WorkspaceID         string
	WorkspaceNote       string
}

func (g *ACPGateway) runtimeRecoverySnapshot(ctx context.Context, sessionID string, runtime ACPSessionRuntime) workspaceRecoverySnapshot {
	snapshot := workspaceRecoverySnapshot{
		Runtime:    runtime,
		Restorable: runtimeCanRecreate(runtime),
	}
	rec, ok := g.loadRecoveryWorkspaceRecord(ctx, sessionID, runtime)
	if !ok {
		return snapshot
	}
	snapshot.WorkspacePersistent = workspaceRecordCanRecreateRuntime(rec)
	snapshot.WorkspaceID = rec.WorkspaceID
	if !snapshot.WorkspacePersistent {
		snapshot.WorkspaceNote = "workspace_not_restorable"
		return snapshot
	}
	snapshot.Runtime = applyWorkspaceRecordToRuntime(runtime, rec)
	snapshot.Restorable = true
	snapshot.WorkspaceNote = "workspace_store_persistent"
	return snapshot
}

func (g *ACPGateway) loadRecoveryWorkspaceRecord(ctx context.Context, sessionID string, runtime ACPSessionRuntime) (WorkspaceRecord, bool) {
	if g == nil || g.store == nil {
		return WorkspaceRecord{}, false
	}
	for _, workspaceID := range runtimeWorkspaceIDCandidates(sessionID, runtime) {
		rec, ok, err := g.store.LoadWorkspace(ctx, workspaceID)
		if err == nil && ok {
			return rec, true
		}
	}
	rec, ok, err := g.store.LoadWorkspaceForSession(ctx, sessionID)
	if err == nil && ok {
		return rec, true
	}
	return WorkspaceRecord{}, false
}

func runtimeWorkspaceIDCandidates(sessionID string, runtime ACPSessionRuntime) []string {
	raw := []string{
		runtime.WorkspaceID,
		runtime.WispWorkspaceID,
		runtime.WispSMHSpaceID,
	}
	if strings.TrimSpace(sessionID) != "" {
		raw = append(raw, "workspace_"+sessionID)
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func workspaceRecordCanRecreateRuntime(rec WorkspaceRecord) bool {
	if strings.TrimSpace(rec.WorkspaceID) == "" {
		return false
	}
	state := strings.ToLower(strings.TrimSpace(rec.State))
	if state == "deleted" || state == "deleting" || state == "failed_terminal" {
		return false
	}
	deleteState := strings.ToLower(strings.TrimSpace(rec.DeleteState))
	if deleteState == "deleted" || deleteState == "deleting" {
		return false
	}
	backend := strings.ToLower(strings.TrimSpace(rec.Backend))
	if backend != "" && backend != "wisp" && backend != "smh" {
		return false
	}
	return firstNonEmpty(rec.WispSMHSpaceID, rec.ProviderWorkspaceID, rec.WorkspaceID) != ""
}

func applyWorkspaceRecordToRuntime(runtime ACPSessionRuntime, rec WorkspaceRecord) ACPSessionRuntime {
	spaceID := firstNonEmpty(rec.WispSMHSpaceID, rec.ProviderWorkspaceID, rec.WorkspaceID)
	runtime.OuterRuntime = firstNonEmpty(runtime.OuterRuntime, outerRuntimeWisp)
	runtime.RuntimeRecovery = firstNonEmpty(runtime.RuntimeRecovery, runtimeRecoveryReattachOrRecreate)
	runtime.WispWorkspaceID = firstNonEmpty(runtime.WispWorkspaceID, rec.WorkspaceID, spaceID)
	runtime.WispSMHSpaceID = firstNonEmpty(runtime.WispSMHSpaceID, spaceID)
	runtime.WispName = firstNonEmpty(runtime.WispName, rec.WispName)
	runtime.WispOwnsSMHSpace = runtime.WispOwnsSMHSpace || rec.WispOwnsSMHSpace
	runtime.WorkspaceWispName = firstNonEmpty(runtime.WorkspaceWispName, rec.WorkspaceWispName)
	runtime.WorkspaceRuntimeID = firstNonEmpty(runtime.WorkspaceRuntimeID, rec.WorkspaceRuntimeID)
	runtime.WispPackageURL = firstNonEmpty(runtime.WispPackageURL, rec.WispPackageURL)
	runtime.WispJFSPrefix = firstNonEmpty(runtime.WispJFSPrefix, rec.WispJFSPrefix)
	runtime.WispRootUpperSize = firstNonEmpty(runtime.WispRootUpperSize, rec.WispRootUpperSize)
	runtime.WorkspaceID = firstNonEmpty(runtime.WorkspaceID, rec.WorkspaceID)
	runtime.WorkspaceVersion = firstNonEmpty(runtime.WorkspaceVersion, rec.WorkspaceVersion)
	return runtime
}
