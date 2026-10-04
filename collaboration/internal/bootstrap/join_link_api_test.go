package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	credentialsadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/credentials"
	"git.woa.com/wisp/mono2/collaboration/internal/api/openapi"
)

func TestPlatformAPIJoinLinkAcceptRegistersAuthenticatedRoute(t *testing.T) {
	handle := openHumanAPIDatabase(t)
	handler, err := NewPlatformAPIHandler(PlatformAPIConfig{
		Human: HumanAPIConfig{Auth: AuthAPIConfig{
			Database: handle, AccessTokenKey: bytes.Repeat([]byte{0x62}, 32),
			Password: credentialsadapter.TestArgon2idConfig(), AccessTTL: 15 * time.Minute,
			RefreshTTL: 24 * time.Hour, RequestTimeout: 5 * time.Second, MaxBodyBytes: 16 * 1024,
		}, SDKAppID: 1600000000, UserSigTTL: time.Hour, UserSigIssuer: &recordingUserSigIssuer{}},
		IMResourceKey: bytes.Repeat([]byte{0x63}, 32), ServerCreationWait: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	accounts := make([]openapi.AuthResult, 0, 2)
	for _, name := range []string{"owner", "receiver"} {
		registered := performJSON(t, handler, http.MethodPost, "/v1/auth/register",
			map[string]any{"email": name + "@example.com", "password": "test-password-123", "displayName": name}, "")
		if registered.Code != http.StatusCreated {
			t.Fatalf("register = %d %s", registered.Code, registered.Body)
		}
		auth := decodeAuthResult(t, registered)
		if _, err := handle.Client().Account.UpdateOneID(auth.Account.Id.String()).
			SetImUserID("u_" + name).SetImState("ready").AddRevision(1).Save(context.Background()); err != nil {
			t.Fatal(err)
		}
		accounts = append(accounts, auth)
	}
	created := platformJSON(t, handler, http.MethodPost, "/v1/servers",
		map[string]any{"slug": "join-link-regression", "name": "Join link regression"},
		*accounts[0].AccessToken, "join-link-server-0001")
	if created.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", created.Code, created.Body)
	}
	var server openapi.AcceptedResource
	if err := json.Unmarshal(created.Body.Bytes(), &server); err != nil {
		t.Fatal(err)
	}
	invited := performJSON(t, handler, http.MethodPost, "/v1/servers/"+server.ResourceId.String()+"/invites",
		map[string]any{"role": "member", "maxUses": 1, "expiresAt": time.Now().UTC().Add(time.Hour)},
		*accounts[0].AccessToken)
	if invited.Code != http.StatusCreated {
		t.Fatalf("invite = %d %s", invited.Code, invited.Body)
	}
	var invite openapi.InviteSecret
	if err := json.Unmarshal(invited.Body.Bytes(), &invite); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"token": *invite.Token}
	unauthenticated := platformJSON(t, handler, http.MethodPost, "/v1/join-links/accept", body, "", "join-link-accept-0001")
	assertAPIError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
	var first openapi.JoinResult
	for attempt := 0; attempt < 2; attempt++ {
		joined := platformJSON(t, handler, http.MethodPost, "/v1/join-links/accept", body,
			*accounts[1].AccessToken, "join-link-accept-0001")
		if joined.Code != http.StatusOK {
			t.Fatalf("accept attempt %d = %d %s", attempt, joined.Code, joined.Body)
		}
		var result openapi.JoinResult
		if err := json.Unmarshal(joined.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.ServerId != server.ResourceId || result.ServerSlug != "join-link-regression" ||
			result.MemberId.String() == "00000000-0000-0000-0000-000000000000" ||
			result.LandingChannelId.String() == "00000000-0000-0000-0000-000000000000" {
			t.Fatalf("unexpected join destination: %#v", result)
		}
		if attempt == 0 {
			first = result
		} else if result.MemberId != first.MemberId || result.LandingChannelId != first.LandingChannelId {
			t.Fatal("idempotent replay changed join destination")
		}
	}
}
