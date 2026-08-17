package humantui

import (
	"context"
	"encoding/json"
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

func TestHumanClientBundleRendersNarrowTerminalRemediation(t *testing.T) {
	application, err := New(Config{
		PlatformURL: "https://platform.example.test",
		StateRoot:   t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	application.runtime.Resize(80, 24)

	tree := waitForHumanTree(t, application, 2*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-width-remediation") != nil
	})
	if got := tree.TextContent(); !strings.Contains(got, "终端宽度不足") ||
		!strings.Contains(got, "至少 96 × 22") {
		t.Fatalf("narrow terminal remediation = %q", got)
	}
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
		case "/v1/servers/server-1/agents", "/v1/servers/server-1/computers":
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

func TestHumanClientSwitchesServerAndSubmitsComputerForm(t *testing.T) {
	account := `{"id":"account-1","email":"human@example.com","displayName":"测试用户","imUserId":"human-im-1","imState":"ready","revision":1}`
	created := make(chan map[string]any, 1)
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
			_, _ = writer.Write([]byte(`{"items":[{"id":"server-1","slug":"alpha","name":"Alpha","ownerMemberId":"member-1","imState":"ready","revision":1},{"id":"server-2","slug":"beta","name":"Beta","ownerMemberId":"member-2","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels":
			_, _ = writer.Write([]byte(`[{"id":"channel-1","serverId":"server-1","name":"alpha-general","visibility":"public","joined":true,"imGroupId":"group-1","imTopicId":"topic-1","imState":"ready","revision":1}]`))
		case "/v1/servers/server-2/channels":
			_, _ = writer.Write([]byte(`[{"id":"channel-2","serverId":"server-2","name":"beta-general","visibility":"public","joined":true,"imGroupId":"group-2","imTopicId":"topic-2","imState":"ready","revision":1}]`))
		case "/v1/servers/server-1/members":
			_, _ = writer.Write([]byte(`{"items":[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-2/members":
			_, _ = writer.Write([]byte(`{"items":[{"id":"member-2","serverId":"server-2","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels/channel-1/members", "/v1/servers/server-2/channels/channel-2/members":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-1/direct-conversations", "/v1/servers/server-2/direct-conversations":
			_, _ = writer.Write([]byte(`{"items":[],"nextCursor":null}`))
		case "/v1/servers/server-1/agents", "/v1/servers/server-2/agents":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-1/computers":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-2/computers":
			if request.Method != http.MethodPost {
				_, _ = writer.Write([]byte(`[]`))
				return
			}
			var input map[string]any
			if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			created <- input
			_, _ = writer.Write([]byte(`{"id":"computer-1","serverId":"server-2","name":"Linux 验收","osType":"linux","lifecycleState":"active","connectionState":"waiting","revision":1}`))
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
	application, err := New(Config{
		PlatformURL: server.URL,
		StateRoot:   stateRoot,
		NewTransport: func() (im.Transport, error) {
			return &productFakeTransport{events: make(chan im.Event)}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer application.Close()
	application.runtime.Resize(120, 40)

	alpha := waitForHumanTree(t, application, 3*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-server-option-server-2") != nil && strings.Contains(tree.TextContent(), "alpha-general")
	})
	alpha = settleHumanTree(application, alpha, 500*time.Millisecond, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-server-option-server-2") != nil && strings.Contains(tree.TextContent(), "alpha-general")
	})
	staleAgentHandler := alpha.MustFind("terminal-navigation-navigate-agents").OnPress
	application.runtime.Dispatch(alpha.MustFind("terminal-server-option-server-2").OnPress, map[string]any{"source": "keyboard"})
	beta := waitForHumanTree(t, application, 3*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return strings.Contains(tree.TextContent(), "Beta") && strings.Contains(tree.TextContent(), "beta-general")
	})

	application.runtime.Dispatch(staleAgentHandler, map[string]any{"source": "delayed"})
	staleDeadline := time.Now().Add(300 * time.Millisecond)
	for time.Now().Before(staleDeadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		tree, nextErr := application.runtime.NextCommit(ctx)
		cancel()
		if nextErr != nil {
			continue
		}
		if header := tree.Find("terminal-management-header"); header != nil && strings.Contains(header.TextContent(), "Agent 管理") {
			t.Fatal("stale handler from superseded Server navigated the current application")
		}
		if strings.Contains(tree.TextContent(), "beta-general") {
			beta = tree
		}
	}

	application.runtime.Dispatch(beta.MustFind("terminal-navigation-navigate-computers").OnPress, map[string]any{"source": "keyboard"})
	computers := waitForHumanTree(t, application, 3*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-management-command-create-computer") != nil
	})
	computers = settleHumanTree(application, computers, 300*time.Millisecond, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-management-command-create-computer") != nil
	})
	application.runtime.Dispatch(computers.MustFind("terminal-management-command-create-computer").OnPress, map[string]any{"source": "keyboard"})
	form := waitForHumanTree(t, application, 2*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-management-form-field-computer-name") != nil &&
			tree.Find("terminal-management-form-field-computer-os") != nil
	})
	application.runtime.Dispatch(form.MustFind("terminal-management-form-field-computer-name").OnChangeText, map[string]any{
		"eventCount": 1,
		"value":      "Linux 验收",
	})
	form = waitForHumanTree(t, application, 2*time.Second, func(tree *reactvaxis.NativeNode) bool {
		name := tree.Find("terminal-management-form-field-computer-name")
		return name != nil && name.Value == "Linux 验收" && name.MostRecentEventCount == 1
	})
	application.runtime.Dispatch(form.MustFind("terminal-management-form-field-computer-os").OnValueChange, map[string]any{"value": "linux"})
	form = waitForHumanTree(t, application, 2*time.Second, func(tree *reactvaxis.NativeNode) bool {
		osField := tree.Find("terminal-management-form-field-computer-os")
		return osField != nil && osField.Value == "linux"
	})
	application.runtime.Dispatch(form.MustFind("terminal-management-form-action-submit-computer").OnPress, map[string]any{"source": "keyboard"})

	select {
	case input := <-created:
		if input["name"] != "Linux 验收" || input["osType"] != "linux" {
			t.Fatalf("create Computer input = %#v", input)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Computer form was not submitted")
	}
	written := waitForHumanTree(t, application, 2*time.Second, func(tree *reactvaxis.NativeNode) bool {
		return tree.Find("terminal-management-form-overlay") == nil && strings.Contains(tree.TextContent(), "Linux 验收")
	})
	if written.Find("terminal-management-collection") == nil {
		t.Fatal("created Computer was not selected into the management collection")
	}
}

func TestHumanClientRepairsDriftedTopicMembershipJustInTime(t *testing.T) {
	account := `{"id":"account-1","email":"human@example.com","displayName":"测试用户","imUserId":"human-im-1","imState":"ready","revision":1}`
	var ensureCalls int
	var operationCalls int
	var mu sync.Mutex
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
		case "/v1/servers/server-1/agents", "/v1/servers/server-1/computers":
			_, _ = writer.Write([]byte(`[]`))
		case "/v1/servers/server-1/members":
			_, _ = writer.Write([]byte(`{"items":[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}],"nextCursor":null}`))
		case "/v1/servers/server-1/channels/channel-1/members":
			_, _ = writer.Write([]byte(`[{"id":"member-1","serverId":"server-1","kind":"human","accountId":"account-1","role":"owner","displayName":"测试用户","handle":"human","status":"active","imUserId":"human-im-1","imState":"ready","revision":1}]`))
		case "/v1/servers/server-1/channels/channel-1/members/member-1":
			mu.Lock()
			ensureCalls++
			mu.Unlock()
			_, _ = writer.Write([]byte(`{"resourceId":"membership-1","operations":[{"id":"operation-1","service":"im","kind":"im.membership.ensure","state":"pending","createdAt":"2026-08-17T12:00:00Z"}]}`))
		case "/v1/servers/server-1/operations/operation-1":
			mu.Lock()
			operationCalls++
			currentOperationCall := operationCalls
			mu.Unlock()
			if currentOperationCall == 1 {
				_, _ = writer.Write([]byte(`{"id":"operation-1","service":"im","kind":"im.membership.ensure","state":"pending","createdAt":"2026-08-17T12:00:00Z"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"id":"operation-1","service":"im","kind":"im.membership.ensure","state":"succeeded","createdAt":"2026-08-17T12:00:00Z","completedAt":"2026-08-17T12:00:01Z"}`))
		default:
			t.Logf("unexpected JIT request: %s %s", request.Method, request.URL.Path)
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
	transport := &repairHistoryTransport{productFakeTransport: productFakeTransport{events: make(chan im.Event)}}
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

	deadline := time.Now().Add(6 * time.Second)
	last := ""
	sawRepairing := false
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		tree, commitErr := application.runtime.NextCommit(ctx)
		cancel()
		if commitErr == nil {
			last = tree.TextContent()
			if strings.Contains(last, "正在重新连接") {
				sawRepairing = true
			}
		}
		mu.Lock()
		ensured := ensureCalls
		mu.Unlock()
		if ensured == 1 && sawRepairing && transport.HistoryCalls() == 2 &&
			!strings.Contains(last, "sdk_10007") {
			return
		}
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("JIT repair did not converge: ensures=%d history=%d repairing=%v text=%q", ensureCalls, transport.HistoryCalls(), sawRepairing, last)
}

type safeHistoryError struct{}

func (safeHistoryError) Error() string    { return "must-not-cross" }
func (safeHistoryError) SafeCode() string { return "sdk_10007" }

type repairHistoryTransport struct {
	productFakeTransport
	mu           sync.Mutex
	historyCalls int
}

func (t *repairHistoryTransport) History(context.Context, im.HistoryRequest) (im.HistoryPage, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.historyCalls++
	if t.historyCalls == 1 {
		return im.HistoryPage{}, safeHistoryError{}
	}
	return im.HistoryPage{Completed: true}, nil
}

func (*repairHistoryTransport) UnreadConversations(context.Context) ([]im.UnreadConversation, error) {
	return nil, nil
}

func (*repairHistoryTransport) MarkRead(context.Context, im.Conversation) error { return nil }

func (t *repairHistoryTransport) HistoryCalls() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.historyCalls
}

type productFakeTransport struct {
	events chan im.Event
	once   sync.Once
}

func waitForHumanTree(
	t *testing.T,
	application *App,
	timeout time.Duration,
	accept func(*reactvaxis.NativeNode) bool,
) *reactvaxis.NativeNode {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last *reactvaxis.NativeNode
	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		tree, err := application.runtime.NextCommit(ctx)
		cancel()
		if err != nil {
			if err != context.DeadlineExceeded {
				lastErr = err
			}
			continue
		}
		last = tree
		if accept(tree) {
			return tree
		}
	}
	lastText := ""
	if last != nil {
		lastText = last.TextContent()
	}
	t.Fatalf("Human TUI tree did not reach expected state: error=%v text=%q", lastErr, lastText)
	return nil
}

func settleHumanTree(
	application *App,
	current *reactvaxis.NativeNode,
	duration time.Duration,
	accept func(*reactvaxis.NativeNode) bool,
) *reactvaxis.NativeNode {
	deadline := time.Now().Add(duration)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		tree, err := application.runtime.NextCommit(ctx)
		cancel()
		if err == nil && accept(tree) {
			current = tree
		}
	}
	return current
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
