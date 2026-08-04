package openapi

import (
	"context"
	"slices"
	"testing"
)

func TestServerScopedDirectConversationContractIsGenerated(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	if err := spec.Validate(context.Background()); err != nil {
		t.Fatalf("validate embedded OpenAPI: %v", err)
	}

	operations := []struct {
		path, method, operationID string
		statuses                  []string
	}{
		{"/servers/{serverId}/direct-conversations", "GET", "ListDirectConversations", []string{"200"}},
		{"/servers/{serverId}/direct-conversations", "POST", "CreateDirectConversation", []string{"200", "202"}},
		{"/servers/{serverId}/direct-conversations/{directConversationId}", "GET", "GetDirectConversation", []string{"200"}},
		{"/servers/{serverId}/direct-conversations/{directConversationId}/retry", "POST", "RetryDirectConversation", []string{"202"}},
	}
	for _, expected := range operations {
		item := spec.Paths.Value(expected.path)
		if item == nil {
			t.Errorf("%s %s is missing", expected.method, expected.path)
			continue
		}
		operation := item.GetOperation(expected.method)
		if operation == nil {
			t.Errorf("%s %s is missing", expected.method, expected.path)
			continue
		}
		if operation.OperationID != expected.operationID {
			t.Errorf("%s %s operationId = %q, want %q", expected.method, expected.path, operation.OperationID, expected.operationID)
		}
		for _, status := range expected.statuses {
			if operation.Responses.Value(status) == nil {
				t.Errorf("%s %s response %s is missing", expected.method, expected.path, status)
			}
		}
	}

	for _, name := range []string{
		"DirectConversation",
		"DirectConversationPage",
		"CreateDirectConversationRequest",
		"DirectConversationStatus",
		"DirectConversationIMState",
	} {
		if schema := spec.Components.Schemas[name]; schema == nil || schema.Value == nil {
			t.Errorf("schema %s is missing", name)
		}
	}

	direct := spec.Components.Schemas["DirectConversation"]
	if direct == nil || direct.Value == nil {
		return
	}
	for _, field := range []string{"id", "serverId", "memberA", "memberB", "status", "imGroupId", "imState", "revision"} {
		if !slices.Contains(direct.Value.Required, field) {
			t.Errorf("DirectConversation.required missing %q", field)
		}
	}
}

func TestJoinLinkContractReturnsDeterministicLandingContext(t *testing.T) {
	t.Parallel()

	spec, err := GetSwagger()
	if err != nil {
		t.Fatalf("load embedded OpenAPI: %v", err)
	}
	item := spec.Paths.Value("/join-links/accept")
	if item == nil || item.Post == nil {
		t.Fatal("POST /join-links/accept is missing")
	}
	if got, want := item.Post.OperationID, "AcceptJoinLink"; got != want {
		t.Fatalf("operationId = %q, want %q", got, want)
	}
	response := item.Post.Responses.Value("200")
	if response == nil || response.Value == nil || response.Value.Content.Get("application/json") == nil {
		t.Fatal("POST /join-links/accept has no JSON 200 response")
	}

	joinResult := spec.Components.Schemas["JoinResult"]
	if joinResult == nil || joinResult.Value == nil {
		t.Fatal("schema JoinResult is missing")
	}
	for _, field := range []string{"serverId", "serverSlug", "memberId", "landingChannelId", "operations"} {
		if !slices.Contains(joinResult.Value.Required, field) {
			t.Errorf("JoinResult.required missing %q", field)
		}
	}
	if createInvite := spec.Components.Schemas["CreateInviteRequest"]; createInvite == nil || createInvite.Value == nil || createInvite.Value.Properties["landingChannelId"] == nil {
		t.Error("CreateInviteRequest.landingChannelId is missing")
	}
}
