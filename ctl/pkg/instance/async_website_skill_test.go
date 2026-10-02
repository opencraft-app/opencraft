package instance

import (
	"context"
	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"
	"errors"
	"go.uber.org/zap"
	"testing"
)

func TestWebsiteSkillSelectsExactRegionWithoutCredentialParameters(t *testing.T) {
	for _, region := range []string{"ap-shanghai", "ap-singapore", "ap-johorbahru"} {
		t.Run(region, func(t *testing.T) {
			a := &createTaskSandboxAdapterStub{sandboxRegion: region}
			store := &createCredentialStore{issueToken: "synthetic-only"}
			ids := map[string]string{"ap-shanghai": "cmd-shskill", "ap-singapore": "cmd-sgskill", "ap-johorbahru": "cmd-johskill"}
			l := &logic{sandboxAdapter: a, logger: zap.NewNop(), websiteSkillTATCommandIDsByRegion: ids, websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-credential"}
			l.deliverWebsiteSkillOnCreate(pctx.NewContext(context.Background()), &modelinstance.Entity{InstanceId: "ins-test", UserId: "usr-test"}, "sbx-test")
			if len(a.invokeCalls) != 1 || a.invokeCalls[0].commandID != ids[region] || len(a.invokeCalls[0].parameters) != 0 {
				t.Fatalf("unexpected Skill calls: %+v", a.invokeCalls)
			}
			if a.invokeCalls[0].timeoutSec != websiteSkillDeliveryTimeout {
				t.Fatal("unbounded Skill timeout")
			}
			if len(store.provisionalTTLs) != 0 || len(store.revokedInstanceIDs) != 0 || len(store.activatedKeyIDs) != 0 {
				t.Fatal("Skill hook touched credential lifecycle")
			}
		})
	}
}

func TestWebsiteSkillSkipsDisabledUnknownOrConflictingConfiguration(t *testing.T) {
	tests := []struct {
		name, region, credential string
		ids, credentialIDs       map[string]string
		lookupErr                error
		incomplete               bool
	}{
		{name: "default-disabled", region: "ap-shanghai"},
		{name: "unknown-region", region: "ap-unknown", ids: map[string]string{"ap-shanghai": "cmd-skill"}},
		{name: "missing-region", ids: map[string]string{"ap-shanghai": "cmd-skill"}},
		{name: "lookup-failure", region: "ap-shanghai", ids: map[string]string{"ap-shanghai": "cmd-skill"}, lookupErr: errors.New("synthetic failure")},
		{name: "legacy-overlap", region: "ap-shanghai", credential: "cmd-skill", ids: map[string]string{"ap-shanghai": "cmd-skill"}},
		{name: "mapped-overlap", region: "ap-shanghai", ids: map[string]string{"ap-shanghai": "cmd-skill"}, credentialIDs: map[string]string{"ap-singapore": "cmd-skill"}},
		{name: "invalid-command", region: "ap-shanghai", ids: map[string]string{"ap-shanghai": "invalid"}},
		{name: "incomplete-target", region: "ap-shanghai", ids: map[string]string{"ap-shanghai": "cmd-skill"}, incomplete: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a := &createTaskSandboxAdapterStub{sandboxRegion: tc.region, sandboxErr: tc.lookupErr}
			l := &logic{sandboxAdapter: a, logger: zap.NewNop(), websiteSkillTATCommandIDsByRegion: tc.ids, websiteCredentialTATCommandID: tc.credential, websiteCredentialTATCommandIDsByRegion: tc.credentialIDs}
			entity := &modelinstance.Entity{InstanceId: "ins-test", UserId: "usr-test"}
			if tc.incomplete {
				entity = nil
			}
			l.deliverWebsiteSkillOnCreate(pctx.NewContext(context.Background()), entity, "sbx-test")
			if len(a.invokeCalls) != 0 {
				t.Fatalf("must fail closed: %+v", a.invokeCalls)
			}
		})
	}
}

func TestWebsiteSkillConfigDefaultsOffAndInvalidMapFailsClosed(t *testing.T) {
	for _, raw := range []string{"", "not-json", "null", `[]`, `{"ap-shanghai":""}`, `{"ap-shanghai":"wrong"}`, `{" ap-shanghai":"cmd-skill"}`, `{"ap-shanghai":"cmd-skill","ap-shanghai":"cmd-other"}`, `{"ap-shanghai":"cmd-skill","ap-singapore":"cmd-skill"}`} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION", raw)
			if len(websiteSkillTATCommandIDsByRegionFromEnv()) != 0 {
				t.Fatal("invalid/empty Skill map must disable")
			}
		})
	}
	t.Setenv("WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION", `{"ap-shanghai":" cmd-skill "}`)
	if websiteSkillTATCommandIDsByRegionFromEnv()["ap-shanghai"] != "cmd-skill" {
		t.Fatal("valid Skill map not parsed")
	}
}

type skillFailureSandbox struct{ *createTaskSandboxAdapterStub }

func (s *skillFailureSandbox) InvokeCommand(ctx context.Context, sandboxID, commandID string, params map[string]string, timeout int) (*psandbox.ExecCommandResult, error) {
	result, err := s.createTaskSandboxAdapterStub.InvokeCommand(ctx, sandboxID, commandID, params, timeout)
	if commandID == "cmd-skill" {
		return nil, errors.New("synthetic Skill-only failure")
	}
	return result, err
}

func TestCreateWebsiteSkillFailureDoesNotBlockCredentialOrRunning(t *testing.T) {
	dao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{Id: 901, InstanceId: "ins-new", UserId: "usr-new", Status: modelinstance.InstanceStatusCreating}}
	base := &createTaskSandboxAdapterStub{sandboxRegion: "ap-shanghai", createResp: &psandbox.Sandbox{SandboxID: "sbx-new", TemplateID: "tpl-create"}, pools: []psandbox.Pool{{ID: "tpl-create", Status: "active", CapacityState: "active"}}}
	adapter := &skillFailureSandbox{base}
	store := &createCredentialStore{issueToken: "synthetic-only"}
	l := &logic{instanceDao: dao, sandboxAdapter: adapter, logger: zap.NewNop(), defaultTemplate: "tpl-create", candidateTemplates: []string{"tpl-create"}, websiteSkillTATCommandIDsByRegion: map[string]string{"ap-shanghai": "cmd-skill"}, websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-credential", websiteAgentAPIBase: "https://api.invalid"}
	if err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("usr-new"), &CreateInstanceTaskPayload{InstanceID: "ins-new", Timeout: 600}); err != nil {
		t.Fatal(err)
	}
	if dao.entity.Status != modelinstance.InstanceStatusRunning {
		t.Fatal("Skill failure blocked Running")
	}
	if len(base.invokeCalls) != 2 || base.invokeCalls[0].commandID != "cmd-skill" || base.invokeCalls[1].commandID != "cmd-credential" {
		t.Fatalf("independent hooks not invoked: %+v", base.invokeCalls)
	}
	if len(base.invokeCalls[0].parameters) != 0 || base.invokeCalls[1].parameters["website_key"] != "synthetic-only" || len(store.activatedKeyIDs) != 1 {
		t.Fatal("credential flow changed")
	}
}

func TestWebsiteCredentialRefusesSkillCommandCollisionBeforeKeyIssue(t *testing.T) {
	a := &createTaskSandboxAdapterStub{sandboxRegion: "ap-shanghai"}
	store := &createCredentialStore{issueToken: "synthetic-only"}
	l := &logic{sandboxAdapter: a, logger: zap.NewNop(), websiteSkillTATCommandIDsByRegion: map[string]string{"ap-shanghai": "cmd-shared"}, websiteCredentialStore: store, websiteCredentialTATCommandID: "cmd-shared", websiteAgentAPIBase: "https://api.invalid"}
	l.deliverWebsiteCredentialOnCreate(pctx.NewContext(context.Background()), &modelinstance.Entity{InstanceId: "ins-test", UserId: "usr-test"}, "sbx-test")
	if len(a.invokeCalls) != 0 || len(store.provisionalTTLs) != 0 || len(store.revokedInstanceIDs) != 0 {
		t.Fatal("collision issued credential or invoked command")
	}
}

type skillResultSandbox struct {
	*createTaskSandboxAdapterStub
	result *psandbox.ExecCommandResult
	err    error
}

func (s *skillResultSandbox) InvokeCommand(ctx context.Context, sandboxID, commandID string, parameters map[string]string, timeout int) (*psandbox.ExecCommandResult, error) {
	_, _ = s.createTaskSandboxAdapterStub.InvokeCommand(ctx, sandboxID, commandID, parameters, timeout)
	return s.result, s.err
}

func TestWebsiteSkillFailureIsSingleAttemptWithoutRepair(t *testing.T) {
	tests := []struct {
		name   string
		result *psandbox.ExecCommandResult
		err    error
	}{
		{name: "invoke-failure", err: errors.New("synthetic failure")},
		{name: "no-result"},
		{name: "start-failed", result: &psandbox.ExecCommandResult{Status: "START_FAILED", ErrorInfo: "InvalidUser: user `agentuser` not exists"}},
		{name: "nonzero-exit", result: &psandbox.ExecCommandResult{Status: "SUCCESS", ExitCode: 1}},
		{name: "offline", result: &psandbox.ExecCommandResult{Status: "DELIVER_FAILED"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			base := &createTaskSandboxAdapterStub{sandboxRegion: "ap-shanghai"}
			a := &skillResultSandbox{base, tc.result, tc.err}
			l := &logic{sandboxAdapter: a, logger: zap.NewNop(), websiteSkillTATCommandIDsByRegion: map[string]string{"ap-shanghai": "cmd-skill"}}
			l.deliverWebsiteSkillOnCreate(pctx.NewContext(context.Background()), &modelinstance.Entity{InstanceId: "ins-test", UserId: "usr-test"}, "sbx-test")
			if len(base.invokeCalls) != 1 || len(base.invokeCalls[0].parameters) != 0 || len(base.processCalls) != 0 {
				t.Fatal("failure was retried or repaired")
			}
		})
	}
}

func TestAlreadyRunningCreateTaskDoesNotReplaySkillHook(t *testing.T) {
	dao := &createTaskInstanceDaoStub{entity: &modelinstance.Entity{Id: 902, InstanceId: "ins-existing", UserId: "usr-existing", SandboxId: "sbx-existing", Status: modelinstance.InstanceStatusRunning}}
	a := &createTaskSandboxAdapterStub{sandboxRegion: "ap-shanghai"}
	l := &logic{instanceDao: dao, sandboxAdapter: a, logger: zap.NewNop(), websiteSkillTATCommandIDsByRegion: map[string]string{"ap-shanghai": "cmd-skill"}}
	if err := l.RunCreateInstanceTask(pctx.NewContext(context.Background()).WithUserID("usr-existing"), &CreateInstanceTaskPayload{InstanceID: "ins-existing", Timeout: 600}); err != nil {
		t.Fatal(err)
	}
	if len(a.invokeCalls) != 0 {
		t.Fatal("already-Running task replayed optional Skill hook")
	}
}
