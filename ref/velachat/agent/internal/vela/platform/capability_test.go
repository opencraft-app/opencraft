//go:build darwin || linux

package platform

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"velachat/agent/internal/common"
)

func TestPutComputerAgentProfileCapabilityResult(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 18, 10, 0, 0, 0, time.UTC)
	operationID := "01989c24-7540-7f12-a27b-c83243215dd9"
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Method != http.MethodPut ||
			request.URL.Path != "/v1/computer/agents/"+computerTestAgentID+
				"/profile-capability-results/"+operationID ||
			request.Header.Get("Authorization") != "Bearer computer-short-token" {
			http.Error(response, "bad capability request", http.StatusBadRequest)
			return
		}
		var body ComputerAgentProfileCapabilityResult
		if err := common.DecodeJson(request.Body, &body); err != nil {
			t.Fatal(err)
		}
		if body.RuntimeKind != "codex" || body.ContextGeneration != 7 ||
			body.Models.Status != "succeeded" || len(body.Models.Items) != 1 ||
			body.Skills.Status != "succeeded" || len(body.Skills.Items) != 1 {
			t.Fatalf("capability result body = %#v", body)
		}
		response.Header().Set("Content-Type", "application/json")
		writeComputerJSON(t, response, map[string]any{
			"accepted": true, "reason": "accepted",
		})
	}))
	defer server.Close()
	client, err := NewClient(Config{
		BaseURL: server.URL + "/v1", Now: func() time.Time { return now },
		MaxSessionTTL: 24 * time.Hour, AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	token, err := newComputerAccessToken("computer-short-token")
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.PutComputerAgentProfileCapabilityResult(
		context.Background(), token, computerTestAgentID, operationID,
		ComputerAgentProfileCapabilityResult{
			SchemaVersion: 1, Status: "succeeded", ContextGeneration: 7,
			AuthorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			RuntimeKind:         "codex", RuntimeContextGeneration: 1,
			ObservedThroughSequence: 0,
			Subject: &ProfileCapabilitySubject{
				ComputerID: computerTestID, RuntimeKind: "codex",
				ProfileKind:        "codex_home",
				ProfileFingerprint: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				WorkspacePath:      "/workspace", ContextGeneration: 7,
				AuthorityContextKey:      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				RuntimeContextGeneration: 1, ObservedThroughSequence: 0,
			},
			Source: &ProfileCapabilitySource{
				Protocol: "codex_app_server", RuntimeVersion: "1.2.3",
				DiscoveryMode: "short_lived_process", ForceReload: true,
			},
			Models: ProfileCapabilityModelSection{
				Status: "succeeded", Items: []ProfileCapabilityModel{{
					ID: "gpt-5", Label: "GPT-5",
					SupportedReasoningEfforts: []string{}, ServiceTiers: []string{},
				}}, Warnings: []ProfileCapabilityWarning{},
			},
			Skills: ProfileCapabilitySkillSection{
				Status: "succeeded", Items: []ProfileCapabilitySkill{{
					ID: "review", Name: "review", Description: "Review code",
					Enabled: true, Availability: "available", Scope: "user",
					MissingDependencyTypes: []string{},
				}}, Warnings: []ProfileCapabilityWarning{},
			},
			ObservedAt: now,
		},
	)
	if err != nil || !result.Accepted || result.Reason != "accepted" {
		t.Fatalf("result = (%#v, %v)", result, err)
	}
}

func TestProfileCapabilityResultAllowsPartialSectionSuccess(t *testing.T) {
	modelError := "skill_discovery_failed"
	result := ComputerAgentProfileCapabilityResult{
		SchemaVersion: 1, Status: "succeeded", ContextGeneration: 1,
		AuthorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		RuntimeKind:         "codex", RuntimeContextGeneration: 1,
		ObservedAt: time.Now().UTC(),
		Subject:    &ProfileCapabilitySubject{}, Source: &ProfileCapabilitySource{},
		Models: ProfileCapabilityModelSection{
			Status: "succeeded", Items: []ProfileCapabilityModel{},
			Warnings: []ProfileCapabilityWarning{},
		},
		Skills: ProfileCapabilitySkillSection{
			Status: "failed", Items: []ProfileCapabilitySkill{},
			Warnings: []ProfileCapabilityWarning{}, ErrorCode: &modelError,
		},
	}
	if !validProfileCapabilityResult(result) {
		t.Fatal("partial section success was rejected")
	}
}
