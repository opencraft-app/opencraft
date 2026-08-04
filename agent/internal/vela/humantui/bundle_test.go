package humantui

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"go.rockorager.dev/vaxis/ui"
	"velachat/agent/internal/reactvaxis"
	"velachat/agent/internal/vela/im"
)

func TestEmbeddedBundleIsVersionedAndVerified(t *testing.T) {
	bundle, err := EmbeddedBundle()
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Name != "vela-human-client" || bundle.Protocol != reactvaxis.ProtocolV2 ||
		!strings.Contains(bundle.Source, "reactvaxis/v2") ||
		!strings.Contains(bundle.Source, "terminal-management-frame") ||
		bundle.Source == "" || bundle.SHA256 != expectedBundleSHA256() {
		t.Fatalf("bundle = %#v", bundle)
	}
}

func TestHumanClientBundleRendersCanonicalAuthScreen(t *testing.T) {
	application, err := New(Config{
		PlatformURL: "https://platform.example.test",
		StateRoot:   t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()

	deadline := time.Now().Add(2 * time.Second)
	last := ""
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr != nil {
			lastErr = commitErr
			continue
		}
		harness := reactvaxis.NewHeadlessHarness(
			reactvaxis.NewVaxisAdapter(nil).Build(tree),
			100,
			30,
		)
		last = strings.ReplaceAll(harness.Snapshot(), " ", "")
		if strings.Contains(last, "欢迎回来") &&
			strings.Contains(last, "邮箱") &&
			strings.Contains(last, "密码") {
			return
		}
	}
	t.Fatalf("shared client did not render canonical AuthScreen: error=%v snapshot=%q", lastErr, last)
}

func TestHumanClientBundleRestoresIntoCanonicalWorkspaceShell(t *testing.T) {
	account := `{"id":"account-1","email":"human@example.com","displayName":"测试用户","imUserId":"human-im-1","imState":"ready","revision":1}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/auth/refresh":
			_, _ = writer.Write([]byte(`{"accessToken":"access-next","refreshToken":"refresh-next","expiresAt":"2099-01-01T00:00:00Z","account":` + account + `}`))
		case "/v1/me":
			_, _ = writer.Write([]byte(account))
		case "/v1/me/im/session":
			_, _ = writer.Write([]byte(`{"sdkAppId":1600000000,"userId":"human-im-1","userSig":"test-usersig","expiresAt":"2099-01-01T00:00:00Z"}`))
		case "/v1/servers":
			_, _ = writer.Write([]byte(`{"items":[{"id":"server-1","slug":"test-space","name":"测试空间","ownerMemberId":"member-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels":
			_, _ = writer.Write([]byte(`[{"id":"channel-1","serverId":"server-1","name":"general","visibility":"public","joined":true,"imGroupId":"group-1","imTopicId":"topic-1","imState":"ready","revision":1}]`))
		case "/v1/servers/server-1/direct-conversations":
			_, _ = writer.Write([]byte(`{"items":[],"nextCursor":null}`))
		case "/v1/servers/server-1/agents":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-1/members":
			_, _ = writer.Write([]byte(`{"items":[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels/channel-1/members":
			_, _ = writer.Write([]byte(`[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}]`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	stateRoot := t.TempDir()
	sessionPath := filepath.Join(stateRoot, "human", "session.json")
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionPath, []byte(`{"refreshToken":"refresh-old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := &productFakeTransport{events: make(chan im.Event)}
	application, err := New(Config{
		PlatformURL: server.URL,
		StateRoot:   stateRoot,
		NewTransport: func() (im.Transport, error) {
			return transport, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	application.runtime.Resize(1280, 800)

	deadline := time.Now().Add(3 * time.Second)
	last := ""
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr != nil {
			continue
		}
		harness := reactvaxis.NewHeadlessHarness(reactvaxis.NewVaxisAdapter(nil).Build(tree), 100, 30)
		last = strings.ReplaceAll(harness.Snapshot(), " ", "")
		if strings.Contains(last, "测试空间") && strings.Contains(last, "general") {
			return
		}
	}
	t.Fatalf("shared client did not render canonical WorkspaceShell: %q", last)
}

func TestHumanClientBundleOffersFirstWorkspaceWhenAccountHasNoServer(t *testing.T) {
	account := `{"id":"account-1","email":"human@example.com","displayName":"测试用户","imUserId":"human-im-1","imState":"ready","revision":1}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/auth/refresh":
			_, _ = writer.Write([]byte(`{"accessToken":"access-next","refreshToken":"refresh-next","expiresAt":"2099-01-01T00:00:00Z","account":` + account + `}`))
		case "/v1/me":
			_, _ = writer.Write([]byte(account))
		case "/v1/me/im/session":
			_, _ = writer.Write([]byte(`{"sdkAppId":1600000000,"userId":"human-im-1","userSig":"test-usersig","expiresAt":"2099-01-01T00:00:00Z"}`))
		case "/v1/servers":
			_, _ = writer.Write([]byte(`{"items":[],"nextCursor":null}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	stateRoot := t.TempDir()
	sessionPath := filepath.Join(stateRoot, "human", "session.json")
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionPath, []byte(`{"refreshToken":"refresh-old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := &productFakeTransport{events: make(chan im.Event)}
	application, err := New(Config{
		PlatformURL: server.URL,
		StateRoot:   stateRoot,
		NewTransport: func() (im.Transport, error) {
			return transport, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()

	deadline := time.Now().Add(3 * time.Second)
	last := ""
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr != nil {
			continue
		}
		harness := reactvaxis.NewHeadlessHarness(reactvaxis.NewVaxisAdapter(nil).Build(tree), 100, 30)
		last = strings.ReplaceAll(harness.Snapshot(), " ", "")
		if strings.Contains(last, "建立你的第一个Server") &&
			strings.Contains(last, "Server名称") &&
			strings.Contains(last, "首个Channel") {
			return
		}
	}
	t.Fatalf("human client did not render first workspace setup: %q", last)
}

func TestHumanClientNavigatesAcrossCanonicalManagementPages(t *testing.T) {
	account := `{"id":"account-1","email":"human@example.com","displayName":"测试用户","imUserId":"human-im-1","imState":"ready","revision":1}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/auth/refresh":
			_, _ = writer.Write([]byte(`{"accessToken":"access-next","refreshToken":"refresh-next","expiresAt":"2099-01-01T00:00:00Z","account":` + account + `}`))
		case "/v1/me":
			_, _ = writer.Write([]byte(account))
		case "/v1/me/im/session":
			_, _ = writer.Write([]byte(`{"sdkAppId":1600000000,"userId":"human-im-1","userSig":"test-usersig","expiresAt":"2099-01-01T00:00:00Z"}`))
		case "/v1/servers":
			_, _ = writer.Write([]byte(`{"items":[{"id":"server-1","slug":"test-space","name":"测试空间","ownerMemberId":"member-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels":
			_, _ = writer.Write([]byte(`[{"id":"channel-1","serverId":"server-1","name":"general","visibility":"public","joined":true,"imGroupId":"group-1","imTopicId":"topic-1","imState":"ready","revision":1}]`))
		case "/v1/servers/server-1/direct-conversations":
			_, _ = writer.Write([]byte(`{"items":[],"nextCursor":null}`))
		case "/v1/servers/server-1/agents", "/v1/servers/server-1/computers", "/v1/servers/server-1/inbox", "/v1/servers/server-1/reminders", "/v1/servers/server-1/invites":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-1/tasks":
			_, _ = writer.Write([]byte(`{"items":[],"nextCursor":null}`))
		case "/v1/servers/server-1/members":
			_, _ = writer.Write([]byte(`{"items":[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels/channel-1/members":
			_, _ = writer.Write([]byte(`[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}]`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	stateRoot := t.TempDir()
	sessionPath := filepath.Join(stateRoot, "human", "session.json")
	if err := os.MkdirAll(filepath.Dir(sessionPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sessionPath, []byte(`{"refreshToken":"refresh-old"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	transport := &productFakeTransport{events: make(chan im.Event)}
	application, err := New(Config{
		PlatformURL:  server.URL,
		StateRoot:    stateRoot,
		NewTransport: func() (im.Transport, error) { return transport, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	application.runtime.Resize(1280, 800)

	deadline := time.Now().Add(3 * time.Second)
	var chatTree *reactvaxis.NativeNode
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr == nil && tree.Find("terminal-navigation-navigate-agents") != nil {
			chatTree = tree
			break
		}
	}
	if chatTree == nil {
		t.Fatal("shared client never exposed Agent navigation")
	}
	settleDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(settleDeadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr == nil && tree.Find("terminal-navigation-navigate-agents") != nil {
			chatTree = tree
		}
	}
	visibleNavigation := map[string]string{
		"chat":      "聊天",
		"tasks":     "任务",
		"agents":    "Agent",
		"computers": "Computer",
		"members":   "成员",
	}
	for section, want := range visibleNavigation {
		navigation := chatTree.Find("terminal-navigation-navigate-" + section)
		if navigation == nil {
			t.Fatalf("%s navigation is missing", section)
		}
		if got := navigation.Title; got != want {
			t.Fatalf("%s navigation text = %q, want %q", section, got, want)
		}
	}
	conversationFrame := chatTree.MustFind("terminal-conversation-frame")
	if conversationFrame.Style.Surface != "canvas" {
		t.Fatalf("conversation frame surface = %q, want canvas", conversationFrame.Style.Surface)
	}
	wantRegionWidths := map[string]int{
		"terminal-navigation":        18,
		"terminal-conversation-list": 30,
	}
	wantRegionSurfaces := map[string]string{
		"terminal-navigation":        "raised",
		"terminal-conversation-list": "raised",
	}
	for _, region := range []string{"terminal-navigation", "terminal-conversation-list"} {
		node := chatTree.Find(region)
		if node == nil {
			t.Fatalf("%s region is missing", region)
		}
		if node.Style.Surface != wantRegionSurfaces[region] {
			t.Fatalf("%s surface = %q, want %q", region, node.Style.Surface, wantRegionSurfaces[region])
		}
		if wantWidth, fixed := wantRegionWidths[region]; fixed {
			if node.Style.Width != wantWidth {
				t.Fatalf("%s width = %d, want %d fixed", region, node.Style.Width, wantWidth)
			}
		}
	}
	geometry := reactvaxis.NewGeometryObserver()
	harness := reactvaxis.NewHeadlessHarness(
		reactvaxis.NewVaxisAdapterWithGeometry(nil, geometry).Build(chatTree),
		120,
		40,
	)
	for _, width := range []int{120, 150, 200} {
		if width != 120 {
			harness.Resize(width, 40)
		}
		wantRects := map[string]ui.Rect{
			"terminal-navigation":        {X: 0, Y: 0, Width: 18, Height: 40},
			"terminal-conversation-list": {X: 18, Y: 0, Width: 30, Height: 40},
		}
		for testID, want := range wantRects {
			got, ok := geometry.Rect(testID)
			if !ok || got != want {
				t.Fatalf("%d cols %s rect = %#v,%v, want %#v", width, testID, got, ok, want)
			}
		}
	}
	// The headless geometry pass can be slower under -race while the injected
	// store is still publishing its final refresh commit. Drain to the newest
	// tree before dispatching a handler because ReactVaxis intentionally fences
	// handler IDs from superseded commits.
	settleDeadline = time.Now().Add(750 * time.Millisecond)
	for time.Now().Before(settleDeadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr == nil && tree.Find("terminal-navigation-navigate-agents") != nil {
			chatTree = tree
		}
	}
	targets := []struct {
		section string
		header  string
	}{
		{section: "agents", header: "Agent 管理"},
		{section: "computers", header: "计算资源"},
		{section: "tasks", header: "协作任务"},
		{section: "members", header: "成员管理"},
	}
	currentTree := chatTree
	for _, target := range targets {
		navigation := currentTree.MustFind("terminal-navigation-navigate-" + target.section)
		previousRouteKey := currentTree.MustFind("human-client-navigation-stack").ActiveRouteKey
		if navigation.OnPress == "" {
			t.Fatalf("%s navigation has no React handler", target.section)
		}
		application.runtime.Dispatch(navigation.OnPress, map[string]any{"source": "pressable"})

		deadline = time.Now().Add(3 * time.Second)
		lastText := ""
		var lastErr error
		var reached *reactvaxis.NativeNode
		for time.Now().Before(deadline) {
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			tree, commitErr := application.runtime.NextCommit(ctx)
			cancel()
			if commitErr != nil {
				if commitErr != context.DeadlineExceeded {
					lastErr = commitErr
				}
				continue
			}
			lastText = tree.TextContent()
			header := tree.Find("terminal-management-header")
			if tree.Find("terminal-management-frame") == nil || header == nil || !strings.Contains(header.TextContent(), target.header) {
				continue
			}
			stack := tree.MustFind("human-client-navigation-stack")
			if len(stack.Children) != 1 {
				t.Fatalf("%s mounted route count = %d, want 1", target.section, len(stack.Children))
			}
			if stack.ActiveRouteKey == "" || stack.ActiveRouteKey == previousRouteKey {
				t.Fatalf("%s route key = %q, was not remounted from %q", target.section, stack.ActiveRouteKey, previousRouteKey)
			}
			reached = tree
			break
		}
		if reached == nil {
			t.Fatalf("shared client did not navigate to %s: error=%v text=%q", target.section, lastErr, lastText)
		}
		currentTree = reached
		settleDeadline = time.Now().Add(250 * time.Millisecond)
		for time.Now().Before(settleDeadline) {
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			tree, commitErr := application.runtime.NextCommit(ctx)
			cancel()
			header := tree.Find("terminal-management-header")
			if commitErr == nil && tree.Find("terminal-management-frame") != nil && header != nil && strings.Contains(header.TextContent(), target.header) {
				currentTree = tree
			}
		}
	}
}

type productFakeTransport struct {
	events chan im.Event
	once   sync.Once
}

func (*productFakeTransport) Start(context.Context, im.Session) error { return nil }
func (*productFakeTransport) SendText(context.Context, im.SendTextRequest) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}
func (*productFakeTransport) SendCustom(context.Context, im.SendCustomRequest) (im.SendReceipt, error) {
	return im.SendReceipt{}, nil
}
func (t *productFakeTransport) Events() <-chan im.Event { return t.events }
func (t *productFakeTransport) Close(context.Context) error {
	t.once.Do(func() { close(t.events) })
	return nil
}
