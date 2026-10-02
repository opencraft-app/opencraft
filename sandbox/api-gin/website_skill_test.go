package main

import (
	"bytes"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/service"
	"cvm-mock-e2b/internal/store"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWebsiteSkillConfigDisabledByDefaultAndStrict(t *testing.T) {
	for _, raw := range []string{"", "not-json", "null", `[]`, `{"ap-beijing":""}`, `{"ap-beijing":"invalid"}`, `{" ap-beijing":"cmd-skill"}`, `{"ap-beijing":"cmd-skill","ap-beijing":"cmd-other"}`, `{"ap-beijing":"cmd-skill","ap-seoul":"cmd-skill"}`} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION", raw)
			if len(loadConfig().AllowedSkillTATCommandIDsByRegion) != 0 {
				t.Fatal("invalid/empty Skill map must disable")
			}
		})
	}
	t.Setenv("WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION", `{"ap-beijing":" cmd-skill "}`)
	if loadConfig().AllowedSkillTATCommandIDsByRegion["ap-beijing"] != "cmd-skill" {
		t.Fatal("valid Skill map not parsed")
	}
}

func TestInternalWebsiteSkillAllowlistAndParameterIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name, command, params string
		skill, credentialIDs  map[string]string
		credential            string
		status                int
	}{
		{name: "skill-empty", command: "cmd-skill", params: `{}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, status: http.StatusAccepted},
		{name: "skill-null", command: "cmd-skill", params: `null`, skill: map[string]string{"ap-beijing": "cmd-skill"}, status: http.StatusAccepted},
		{name: "skill-cannot-take-credential", command: "cmd-skill", params: `{"website_key":"synthetic-only"}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, status: http.StatusBadRequest},
		{name: "credential-needs-parameters", command: "cmd-credential", params: `{}`, credential: "cmd-credential", status: http.StatusBadRequest},
		{name: "credential-keeps-parameters", command: "cmd-credential", params: `{"website_key":"synthetic-only","api_base":"https://api.invalid"}`, credential: "cmd-credential", skill: map[string]string{"ap-beijing": "cmd-skill"}, status: http.StatusAccepted},
		{name: "unknown-command", command: "cmd-unknown", params: `{}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, status: http.StatusForbidden},
		{name: "skill-disabled", command: "cmd-skill", params: `{}`, status: http.StatusForbidden},
		{name: "other-region", command: "cmd-skill", params: `{}`, skill: map[string]string{"ap-seoul": "cmd-skill"}, status: http.StatusForbidden},
		{name: "skill-overlap-legacy", command: "cmd-skill", params: `{}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, credential: "cmd-skill", status: http.StatusForbidden},
		{name: "credential-overlap-legacy", command: "cmd-skill", params: `{"website_key":"synthetic-only"}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, credential: "cmd-skill", status: http.StatusForbidden},
		{name: "mapped-overlap", command: "cmd-skill", params: `{}`, skill: map[string]string{"ap-beijing": "cmd-skill"}, credentialIDs: map[string]string{"ap-seoul": "cmd-skill"}, status: http.StatusForbidden},
		{name: "credential-unknown-region-no-fallback", command: "cmd-credential", params: `{"website_key":"synthetic-only"}`, credential: "cmd-credential", credentialIDs: map[string]string{"ap-seoul": "cmd-credential"}, status: http.StatusForbidden},
		{name: "credential-empty-value-rejected", command: "cmd-credential", params: `{"website_key":""}`, credential: "cmd-credential", status: http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := service.NewService(store.NewMemoryStore())
			_, _, sb := createAllocatedSandbox(t, svc)
			invoker := &stubCommandInvoker{resp: provider.CommandInvocation{InvocationID: "inv-skill"}}
			h := &handler{svc: svc, invocations: invoker, allowedTATCommandID: tc.credential, allowedTATCommandIDsByRegion: tc.credentialIDs, allowedSkillTATCommandIDsByRegion: tc.skill}
			router := newInternalTATTestRouter(h)
			req := httptest.NewRequest(http.MethodPost, "/internal/sandboxes/"+sb.ID+"/tat/invocations", bytes.NewBufferString(`{"command_id":"`+tc.command+`","parameters":`+tc.params+`}`))
			req.Header.Set("Content-Type", "application/json")
			authorizeInternalTATRequest(req)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status %d want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if tc.status == http.StatusAccepted {
				if invoker.req.commandID != tc.command || invoker.req.region != "ap-beijing" || invoker.req.instanceID != "ins-test-1" {
					t.Fatalf("wrong invocation target: %+v", invoker.req)
				}
			} else if invoker.req.commandID != "" {
				t.Fatal("rejected command reached provider")
			}
		})
	}
}
