package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	tencentimadapter "git.woa.com/wisp/mono2/collaboration/internal/adapters/tencentim"
	botimport "git.woa.com/wisp/mono2/collaboration/internal/ports/botim"
	tencentimport "git.woa.com/wisp/mono2/collaboration/internal/ports/tencentim"

	"github.com/google/uuid"
)

const botTestGatewayToken = "service-gateway-internal-token"

type fakeBotHost struct {
	mu          sync.Mutex
	owned       bool
	deliveries  []botimport.Delivery
	credentials []string
}

func (host *fakeBotHost) Verify(context.Context, botimport.HostRequest) (botimport.HostVerification, error) {
	if !host.owned {
		return botimport.HostVerification{}, botimport.ErrBotNotOwned
	}
	return botimport.HostVerification{DisplayName: "研究助手"}, nil
}

func (host *fakeBotHost) Deliver(_ context.Context, delivery botimport.Delivery) error {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.deliveries = append(host.deliveries, delivery)
	host.credentials = append(host.credentials, delivery.Credential.Reveal())
	return nil
}

func (host *fakeBotHost) Revoke(context.Context, botimport.HostRequest) error { return nil }

func (host *fakeBotHost) lastCredential() string {
	host.mu.Lock()
	defer host.mu.Unlock()
	return host.credentials[len(host.credentials)-1]
}

type fakeIdentities struct{ imported, kicked, deleted []string }

func (identities *fakeIdentities) EnsureIdentity(_ context.Context, identity tencentimport.Identity) error {
	identities.imported = append(identities.imported, identity.UserID)
	return nil
}

func (identities *fakeIdentities) KickIdentity(_ context.Context, userID string) error {
	identities.kicked = append(identities.kicked, userID)
	return nil
}

func (identities *fakeIdentities) DeleteIdentity(_ context.Context, userID string) error {
	identities.deleted = append(identities.deleted, userID)
	return nil
}

type fakeTencentGroups struct {
	created        []botimport.TencentGroup
	added          []string
	removed        []string
	notices        []botimport.PolicyNotice
	createdNotices []string
	renamed        []string
	destroys       []string
}

func (groups *fakeTencentGroups) EnsureGroup(_ context.Context, group botimport.TencentGroup) error {
	groups.created = append(groups.created, group)
	return nil
}

func (groups *fakeTencentGroups) AddMembers(_ context.Context, _ string, userIDs []string) error {
	groups.added = append(groups.added, userIDs...)
	return nil
}

func (groups *fakeTencentGroups) RemoveMembers(_ context.Context, _ string, userIDs []string) error {
	groups.removed = append(groups.removed, userIDs...)
	return nil
}

func (groups *fakeTencentGroups) Rename(_ context.Context, _ string, name string) error {
	groups.renamed = append(groups.renamed, name)
	return nil
}

func (groups *fakeTencentGroups) Destroy(_ context.Context, groupID string) error {
	groups.destroys = append(groups.destroys, groupID)
	return nil
}

func (groups *fakeTencentGroups) SendCreatedNotice(_ context.Context, groupID, creatorUserID string) error {
	groups.createdNotices = append(groups.createdNotices, groupID+" "+creatorUserID)
	return nil
}

func (groups *fakeTencentGroups) SendPolicyNotice(_ context.Context, _ string, notice botimport.PolicyNotice) error {
	groups.notices = append(groups.notices, notice)
	return nil
}

type botAPIFixture struct {
	t          *testing.T
	api        *BotIMAPI
	host       *fakeBotHost
	identities *fakeIdentities
	tencent    *fakeTencentGroups
	// markHumansReady 模拟 Human IM 身份 worker 已完成导入。
	markHumansReady func()
}

func newBotAPIFixture(t *testing.T) *botAPIFixture {
	t.Helper()
	handle := openHumanAPIDatabase(t)
	deriver, err := tencentimadapter.NewIdentityDeriver(bytes.Repeat([]byte{0x24}, 32))
	if err != nil {
		t.Fatal(err)
	}
	fixture := &botAPIFixture{
		t: t, host: &fakeBotHost{owned: true}, identities: &fakeIdentities{}, tencent: &fakeTencentGroups{},
	}
	fixture.api, err = NewBotIMAPI(BotIMAPIConfig{
		Database:                       handle,
		AccessTokenKey:                 bytes.Repeat([]byte{0x42}, 32),
		GatewayHumanToken:              []byte(botTestGatewayToken),
		ExternalHumanProvisioningEpoch: "credential_epoch_test",
		SDKAppID:                       1600000000,
		AccessTTL:                      time.Hour,
		UserSigTTL:                     time.Hour,
		UserSigIssuer: &recordingUserSigIssuer{result: tencentimport.UserSig{
			Value: "test-usersig", ExpiresAt: time.Now().Add(time.Hour),
		}},
		Identities:              fixture.identities,
		Deriver:                 deriver,
		Host:                    fixture.host,
		TencentGroups:           fixture.tencent,
		BotRuntimeAPIBaseURL:    "http://127.0.0.1:18080/v1",
		MaxActiveBotsPerAccount: 2,
		RequestTimeout:          5 * time.Second,
		MaxBodyBytes:            16 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.markHumansReady = func() {
		accounts, err := handle.Client().Account.Query().All(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for index, entity := range accounts {
			if err := handle.Client().Account.UpdateOneID(entity.ID).
				SetImState("ready").
				SetImUserID("u_HUMAN" + string(rune('A'+index))).
				Exec(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
	}
	return fixture
}

func (fixture *botAPIFixture) do(method, path, authorization, subject string, body any) (int, map[string]any) {
	fixture.t.Helper()
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			fixture.t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if subject != "" {
		request.Header.Set("X-Lightclaw-User-ID", subject)
	}
	recorder := httptest.NewRecorder()
	fixture.api.Handler.ServeHTTP(recorder, request)
	result := map[string]any{}
	if recorder.Body.Len() > 0 {
		_ = json.Unmarshal(recorder.Body.Bytes(), &result)
	}
	return recorder.Code, result
}

func (fixture *botAPIFixture) human(method, path string, body any) (int, map[string]any) {
	return fixture.do(method, path, "Bearer "+botTestGatewayToken, "usr_0123456789abcdef01234567", body)
}

func errorCode(body map[string]any) string {
	envelope, _ := body["error"].(map[string]any)
	code, _ := envelope["code"].(string)
	return code
}

func TestBotIMAPIProvisionsBotIssuesSessionAndManagesGroups(t *testing.T) {
	fixture := newBotAPIFixture(t)

	status, bot := fixture.human(http.MethodPost, "/v1/me/bots", map[string]any{
		"instanceId": "ins-7c4bdf918ac0464fa2b8007afec371bd", "botId": "ins-7c4bdf918ac0464fa2b8007afec371bd",
		"displayName": "助手",
	})
	if status != http.StatusOK || bot["state"] != "ready" || bot["displayName"] != "研究助手" ||
		!strings.HasPrefix(bot["userId"].(string), "a_") {
		t.Fatalf("provision = %d %#v", status, bot)
	}
	botUserID := bot["userId"].(string)
	if len(fixture.host.deliveries) != 1 || fixture.host.deliveries[0].APIBaseURL != "http://127.0.0.1:18080/v1" ||
		!strings.HasPrefix(fixture.host.lastCredential(), "vbc_") {
		t.Fatalf("deliveries = %#v", fixture.host.deliveries)
	}
	if len(fixture.identities.imported) != 1 || fixture.identities.imported[0] != botUserID {
		t.Fatalf("imported = %#v", fixture.identities.imported)
	}
	status, again := fixture.human(http.MethodPost, "/v1/me/bots", map[string]any{
		"instanceId": "ins-7c4bdf918ac0464fa2b8007afec371bd", "botId": "ins-7c4bdf918ac0464fa2b8007afec371bd",
		"displayName": "助手",
	})
	if status != http.StatusOK || again["id"] != bot["id"] || len(fixture.host.deliveries) != 1 {
		t.Fatalf("idempotent provision = %d %#v deliveries=%d", status, again, len(fixture.host.deliveries))
	}

	credential := fixture.host.lastCredential()
	status, session := fixture.do(http.MethodPost, "/v1/runtime/bot/session", "BotCredential "+credential, "", nil)
	if status != http.StatusOK {
		t.Fatalf("session = %d %#v", status, session)
	}
	accessToken, _ := session["accessToken"].(string)
	im, _ := session["im"].(map[string]any)
	if accessToken == "" || im["userId"] != botUserID || im["userSig"] != "test-usersig" {
		t.Fatalf("session body = %#v", session)
	}
	status, _ = fixture.do(http.MethodGet, "/v1/runtime/bot/me", "Bearer "+credential, "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("long credential accepted as runtime bearer: %d", status)
	}
	status, me := fixture.do(http.MethodGet, "/v1/runtime/bot/me", "Bearer "+accessToken, "", nil)
	if status != http.StatusOK || me["commandPolicy"] != "owner" {
		t.Fatalf("runtime me = %d %#v", status, me)
	}

	status, body := fixture.human(http.MethodPost, "/v1/me/groups", map[string]any{
		"groupId": uuid.Must(uuid.NewV7()).String(), "name": "评审", "memberUserIds": []string{botUserID},
	})
	if status != http.StatusConflict || errorCode(body) != "im_identity_not_ready" {
		t.Fatalf("group before human IM ready = %d %#v", status, body)
	}
	fixture.markHumansReady()

	groupID := uuid.Must(uuid.NewV7()).String()
	create := map[string]any{"groupId": groupID, "name": "评审", "memberUserIds": []string{botUserID}}
	status, group := fixture.human(http.MethodPost, "/v1/me/groups", create)
	if status != http.StatusOK || group["viewerRole"] != "owner" || group["effectiveReplyMode"] != "mention" ||
		len(group["members"].([]any)) != 2 {
		t.Fatalf("create group = %d %#v", status, group)
	}
	if len(fixture.tencent.created) != 1 || fixture.tencent.created[0].OwnerUserID != "u_HUMANA" ||
		fixture.tencent.created[0].MemberUserIDs[0] != botUserID {
		t.Fatalf("tencent created = %#v", fixture.tencent.created)
	}
	if len(fixture.tencent.createdNotices) != 1 || fixture.tencent.createdNotices[0] != group["tencentGroupId"].(string)+" u_HUMANA" {
		t.Fatalf("created notices = %#v", fixture.tencent.createdNotices)
	}
	status, retried := fixture.human(http.MethodPost, "/v1/me/groups", create)
	if status != http.StatusOK || retried["id"] != group["id"] || len(fixture.tencent.created) != 1 ||
		len(fixture.tencent.createdNotices) != 1 {
		t.Fatalf("retried create = %d %#v", status, retried)
	}

	groupPath := "/v1/runtime/bot/groups/" + groupID
	status, botView := fixture.do(http.MethodGet, groupPath, "Bearer "+accessToken, "", nil)
	if status != http.StatusOK || botView["viewerRole"] != "member" {
		t.Fatalf("bot view = %d %#v", status, botView)
	}
	status, body = fixture.do(http.MethodPatch, groupPath, "Bearer "+accessToken, "", map[string]any{"replyMode": "all"})
	if status != http.StatusForbidden || errorCode(body) != "permission_denied" {
		t.Fatalf("member changed reply mode = %d %#v", status, body)
	}
	status, updated := fixture.human(http.MethodPatch, "/v1/me/groups/"+groupID, map[string]any{"replyMode": "mention_context"})
	if status != http.StatusOK || updated["contextMessages"] != float64(10) || len(fixture.tencent.notices) != 1 {
		t.Fatalf("update reply mode = %d %#v notices=%d", status, updated, len(fixture.tencent.notices))
	}
	status, body = fixture.human(http.MethodDelete, "/v1/me/groups/"+groupID+"/members/u_HUMANA", nil)
	if status != http.StatusConflict || errorCode(body) != "owner_immutable" {
		t.Fatalf("owner removal = %d %#v", status, body)
	}
	status, _ = fixture.do(http.MethodDelete, groupPath+"/members/"+botUserID, "Bearer "+accessToken, "", nil)
	if status != http.StatusOK || len(fixture.tencent.removed) != 1 {
		t.Fatalf("bot quit = %d removed=%#v", status, fixture.tencent.removed)
	}
	status, _ = fixture.do(http.MethodGet, groupPath, "Bearer "+accessToken, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("removed bot can still read group: %d", status)
	}
	status, onlyHuman := fixture.human(http.MethodGet, "/v1/me/groups/"+groupID, nil)
	if status != http.StatusOK || onlyHuman["effectiveReplyMode"] != "mention_context" {
		t.Fatalf("human-only group = %d %#v", status, onlyHuman)
	}

	status, _ = fixture.human(http.MethodPost, "/v1/me/bots/"+bot["id"].(string)+"/credential", nil)
	if status != http.StatusOK || len(fixture.host.deliveries) != 2 {
		t.Fatalf("rotate = %d deliveries=%d", status, len(fixture.host.deliveries))
	}
	if fixture.host.deliveries[0].OwnerIMUserID != "" || fixture.host.deliveries[1].OwnerIMUserID != "u_HUMANA" {
		t.Fatalf("home channel owner = %q then %q", fixture.host.deliveries[0].OwnerIMUserID, fixture.host.deliveries[1].OwnerIMUserID)
	}
	status, body = fixture.do(http.MethodPost, "/v1/runtime/bot/session", "BotCredential "+credential, "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("rotated credential still accepted = %d %#v", status, body)
	}
	status, _ = fixture.do(http.MethodGet, "/v1/runtime/bot/me", "Bearer "+accessToken, "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("token of rotated credential still accepted = %d", status)
	}
	status, _ = fixture.do(http.MethodPost, "/v1/runtime/bot/session", "BotCredential "+fixture.host.lastCredential(), "", nil)
	if status != http.StatusOK {
		t.Fatalf("new credential rejected = %d", status)
	}
}

func TestBotIMAPIRejectsBotOwnedByAnotherAccount(t *testing.T) {
	fixture := newBotAPIFixture(t)
	fixture.host.owned = false
	status, body := fixture.human(http.MethodPost, "/v1/me/bots", map[string]any{
		"instanceId": "ins-other", "botId": "default", "displayName": "别人的",
	})
	if status != http.StatusForbidden || errorCode(body) != "bot_instance_not_owned" {
		t.Fatalf("provision foreign bot = %d %#v", status, body)
	}
	if len(fixture.identities.imported) != 0 || len(fixture.host.deliveries) != 0 {
		t.Fatalf("foreign bot side effects: imported=%v deliveries=%d", fixture.identities.imported, len(fixture.host.deliveries))
	}
}

func TestBotIMAPICapsActiveBotsAndDeleteFreesTheTencentAccount(t *testing.T) {
	fixture := newBotAPIFixture(t)
	provision := func(botID string) (int, map[string]any) {
		return fixture.human(http.MethodPost, "/v1/me/bots", map[string]any{
			"instanceId": "ins-quota", "botId": botID, "displayName": botID,
		})
	}
	_, first := provision("b1")
	if status, _ := provision("b2"); status != http.StatusOK {
		t.Fatalf("second bot = %d", status)
	}
	status, body := provision("b3")
	if status != http.StatusConflict || errorCode(body) != "bot_quota_exceeded" {
		t.Fatalf("bot over quota = %d %#v", status, body)
	}
	if len(fixture.identities.imported) != 2 || len(fixture.host.deliveries) != 2 {
		t.Fatalf("over-quota side effects: imported=%v deliveries=%d", fixture.identities.imported, len(fixture.host.deliveries))
	}

	firstUserID := first["userId"].(string)
	if status, _ := fixture.human(http.MethodDelete, "/v1/me/bots/"+first["id"].(string), nil); status != http.StatusNoContent {
		t.Fatalf("delete = %d", status)
	}
	if len(fixture.identities.deleted) != 1 || fixture.identities.deleted[0] != firstUserID {
		t.Fatalf("tencent account not deleted: %#v", fixture.identities.deleted)
	}
	if status, _ := provision("b3"); status != http.StatusOK {
		t.Fatalf("bot after freeing a slot = %d", status)
	}
	if status, body := provision("b1"); status != http.StatusConflict || errorCode(body) != "bot_quota_exceeded" {
		t.Fatalf("reviving a deleted bot bypassed the quota = %d %#v", status, body)
	}

	_, list := fixture.human(http.MethodGet, "/v1/me/bots", nil)
	for _, item := range list["items"].([]any) {
		if bot := item.(map[string]any); bot["botId"] == "b2" {
			fixture.human(http.MethodDelete, "/v1/me/bots/"+bot["id"].(string), nil)
		}
	}
	status, revived := provision("b1")
	if status != http.StatusOK || revived["id"] != first["id"] || revived["userId"] != firstUserID ||
		fixture.identities.imported[len(fixture.identities.imported)-1] != firstUserID {
		t.Fatalf("revived bot = %d %#v imported=%v", status, revived, fixture.identities.imported)
	}
}

func TestBotIMAPIRejectsUnknownGroupMembers(t *testing.T) {
	fixture := newBotAPIFixture(t)
	fixture.human(http.MethodGet, "/v1/me/bots", nil)
	fixture.markHumansReady()
	status, body := fixture.human(http.MethodPost, "/v1/me/groups", map[string]any{
		"groupId": uuid.Must(uuid.NewV7()).String(), "name": "x", "memberUserIds": []string{"a_UNKNOWN"},
	})
	if status != http.StatusUnprocessableEntity || errorCode(body) != "im_identity_unknown" {
		t.Fatalf("unknown member = %d %#v", status, body)
	}
	if len(fixture.tencent.created) != 0 {
		t.Fatal("tencent group created for invalid members")
	}
}
