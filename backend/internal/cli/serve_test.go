package cli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"chatserver/internal/api/openapi"
	"chatserver/internal/config"

	"github.com/tencentyun/tls-sig-api-v2-golang/tencentyun"
)

func TestServeCLIStartsAPIOnlyAndStopsWithContext(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "data", "chatserver.db")
	keyPath := writeJWTKey(t, root, 0o600)
	imSecretPath := writeTextSecret(
		t,
		root,
		"im-secret.key",
		"local-test-im-secret",
		0o600,
	)
	identityKeyPath := writeIdentityKey(t, root, 0o600)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stdout := newSignalBuffer("平台 API 与 IM Worker 已启动")
	var stderr bytes.Buffer
	result := make(chan int, 1)
	go func() {
		result <- Run(ctx, []string{
			"serve",
			"--database", databasePath,
			"--listen", "127.0.0.1:0",
			"--jwt-key-file", keyPath,
			"--im-sdk-app-id", "1600000000",
			"--im-admin-user-id", "platform_admin",
			"--im-secret-key-file", imSecretPath,
			"--im-identity-key-file", identityKeyPath,
			"--computer-install-public-url", "https://platform.example.test",
			"--cors-origin", "http://localhost:3000",
		}, stdout, &stderr)
	}()
	select {
	case <-stdout.signaled:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not start; stderr=%q", stderr.String())
	}
	baseURL := startedBaseURL(t, stdout.String())
	for _, path := range []string{
		"/",
		"/_expo/static/js/web/index.js",
		"/assets/logo.png",
		"/s/tencent",
		"/docs",
	} {
		response, err := http.Get(baseURL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s status=%d body=%q", path, response.StatusCode, body)
		}
		if strings.Contains(response.Header.Get("Content-Type"), "text/html") {
			t.Fatalf("GET %s 仍返回 HTML: content-type=%q", path, response.Header.Get("Content-Type"))
		}
	}
	healthResponse, err := http.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_ = healthResponse.Body.Close()
	if healthResponse.StatusCode != http.StatusOK {
		t.Fatalf("GET /healthz status=%d", healthResponse.StatusCode)
	}
	apiResponse, err := http.Get(baseURL + "/v1/me")
	if err != nil {
		t.Fatal(err)
	}
	_ = apiResponse.Body.Close()
	if apiResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET /v1/me status=%d", apiResponse.StatusCode)
	}
	cancel()
	code := <-result

	if code != 0 {
		t.Fatalf("serve code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "平台 API 与 IM Worker 已启动") ||
		!strings.Contains(stdout.String(), "127.0.0.1:") {
		t.Fatalf("serve stdout = %q", stdout.String())
	}
	for _, secretPath := range []string{keyPath, imSecretPath, identityKeyPath} {
		if strings.Contains(stdout.String(), secretPath) ||
			strings.Contains(stderr.String(), secretPath) {
			t.Fatal("serve output leaked secret file path")
		}
	}
}

func TestServeCLIPublicComputerEnrollmentRoutesAreNotShadowedByComputerAPI(t *testing.T) {
	root := t.TempDir()
	releasePath := writeTextSecret(
		t,
		root,
		"computer-release.json",
		`{
  "version":"0.1.0",
  "target":"darwin-arm64",
  "osType":"macos",
  "architecture":"arm64",
  "signingKeyId":"key-1",
  "manifest":{"objectKey":"computer/releases/0.1.0/manifest.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":101},
  "signature":{"objectKey":"computer/releases/0.1.0/manifest.sig","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":102},
  "installer":{"objectKey":"computer/releases/0.1.0/darwin-arm64/install.sh","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","size":103},
  "program":{"objectKey":"computer/releases/0.1.0/darwin-arm64/vela-computer","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","size":104}
}`,
		0o600,
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdout := newSignalBuffer("平台 API 与 IM Worker 已启动")
	var stderr bytes.Buffer
	result := make(chan int, 1)
	go func() {
		result <- Run(ctx, []string{
			"serve",
			"--database", filepath.Join(root, "data", "chatserver.db"),
			"--listen", "127.0.0.1:0",
			"--jwt-key-file", writeJWTKey(t, root, 0o600),
			"--im-sdk-app-id", "1600000000",
			"--im-admin-user-id", "platform_admin",
			"--im-secret-key-file", writeTextSecret(
				t, root, "im-secret.key", "local-test-im-secret", 0o600,
			),
			"--im-identity-key-file", writeIdentityKey(t, root, 0o600),
			"--computer-install-public-url", "https://platform.example.test",
			"--tencent-cloud-secret-id-file", writeTextSecret(
				t, root, "cloud-secret-id", "test-secret-id-0000000000000000", 0o600,
			),
			"--tencent-cloud-secret-key-file", writeTextSecret(
				t, root, "cloud-secret-key", "test-secret-key-000000000000000", 0o600,
			),
			"--computer-release-file", releasePath,
			"--computer-artifact-bucket", "computer-test-1250000000",
			"--computer-artifact-region", "ap-beijing",
		}, stdout, &stderr)
	}()
	select {
	case <-stdout.signaled:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not start; stderr=%q", stderr.String())
	}

	request, err := http.NewRequest(
		http.MethodPost,
		startedBaseURL(t, stdout.String())+"/v1/computer/setup-codes:redeem",
		strings.NewReader("ABCD-EFGH-JKLM-NPQR"),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "text/plain")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusUnauthorized ||
		!bytes.Contains(body, []byte(`"code":"setup_code_invalid"`)) {
		t.Fatalf("redeem status=%d body=%s", response.StatusCode, body)
	}
	claimRequest, err := http.NewRequest(
		http.MethodPost,
		startedBaseURL(t, stdout.String())+"/v1/computer/enrollments:claim",
		strings.NewReader(`{}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	claimRequest.Header.Set("Content-Type", "application/json")
	claimResponse, err := http.DefaultClient.Do(claimRequest)
	if err != nil {
		t.Fatal(err)
	}
	claimBody, err := io.ReadAll(claimResponse.Body)
	_ = claimResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if claimResponse.StatusCode != http.StatusUnauthorized ||
		!bytes.Contains(claimBody, []byte(`"code":"enrollment_invalid"`)) {
		t.Fatalf("claim status=%d body=%s", claimResponse.StatusCode, claimBody)
	}

	cancel()
	if code := <-result; code != 0 {
		t.Fatalf("serve code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestServeCLIRegistrationConvergesToReadyAndIssuesVerifiableUserSig(
	t *testing.T,
) {
	var imported chan string = make(chan string, 1)
	tencentServer := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v4/im_open_login_svc/account_import" {
			t.Fatalf("Tencent path = %s", request.URL.Path)
		}
		var body struct {
			UserID string `json:"UserID"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode Tencent request: %v", err)
		}
		select {
		case imported <- body.UserID:
		default:
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(
			writer,
			`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":""}`,
		)
	}))
	t.Cleanup(tencentServer.Close)

	root := t.TempDir()
	const imSecret = "local-test-im-secret-for-verification"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdout := newSignalBuffer("平台 API 与 IM Worker 已启动")
	var stderr bytes.Buffer
	result := make(chan int, 1)
	go func() {
		result <- Run(ctx, []string{
			"serve",
			"--database", filepath.Join(root, "data", "chatserver.db"),
			"--listen", "127.0.0.1:0",
			"--jwt-key-file", writeJWTKey(t, root, 0o600),
			"--im-sdk-app-id", "1600000000",
			"--im-admin-user-id", "platform_admin",
			"--im-secret-key-file", writeTextSecret(
				t,
				root,
				"im-secret.key",
				imSecret,
				0o600,
			),
			"--im-identity-key-file", writeIdentityKey(t, root, 0o600),
			"--im-rest-base-url", tencentServer.URL,
			"--computer-install-public-url", "https://platform.example.test",
		}, stdout, &stderr)
	}()
	select {
	case <-stdout.signaled:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not start; stderr=%q", stderr.String())
	}
	baseURL := startedBaseURL(t, stdout.String())
	registerBody := strings.NewReader(
		`{"email":"alice@example.com","password":"password-123",` +
			`"displayName":"爱丽丝"}`,
	)
	registerRequest, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/v1/auth/register",
		registerBody,
	)
	if err != nil {
		t.Fatal(err)
	}
	registerRequest.Header.Set("Content-Type", "application/json")
	registerResponse, err := http.DefaultClient.Do(registerRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer registerResponse.Body.Close()
	if registerResponse.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(registerResponse.Body)
		t.Fatalf("register status=%d body=%s", registerResponse.StatusCode, data)
	}
	var auth openapi.AuthResult
	if err := json.NewDecoder(registerResponse.Body).Decode(&auth); err != nil {
		t.Fatal(err)
	}
	if auth.AccessToken == nil {
		t.Fatal("register access token is nil")
	}

	var importedUserID string
	select {
	case importedUserID = <-imported:
	case <-time.After(5 * time.Second):
		t.Fatal("IM Worker did not import registered account")
	}
	var account openapi.Account
	deadline := time.Now().Add(5 * time.Second)
	for {
		request, err := http.NewRequest(
			http.MethodGet,
			baseURL+"/v1/me",
			nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+*auth.AccessToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		decodeErr := json.NewDecoder(response.Body).Decode(&account)
		_ = response.Body.Close()
		if response.StatusCode == http.StatusOK &&
			decodeErr == nil &&
			account.ImState == "ready" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf(
				"GET /me did not become ready: status=%d account=%#v err=%v",
				response.StatusCode,
				account,
				decodeErr,
			)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if account.ImUserId == nil ||
		*account.ImUserId != importedUserID ||
		!strings.HasPrefix(importedUserID, "u_") {
		t.Fatalf("IM identity mismatch: account=%#v imported=%q", account, importedUserID)
	}

	sessionRequest, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/v1/me/im/session",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	sessionRequest.Header.Set("Authorization", "Bearer "+*auth.AccessToken)
	sessionResponse, err := http.DefaultClient.Do(sessionRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer sessionResponse.Body.Close()
	if sessionResponse.StatusCode != http.StatusOK {
		data, _ := io.ReadAll(sessionResponse.Body)
		t.Fatalf("IM session status=%d body=%s", sessionResponse.StatusCode, data)
	}
	var session openapi.ImSession
	if err := json.NewDecoder(sessionResponse.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	if session.UserSig == nil {
		t.Fatal("IM session UserSig is nil")
	}
	if err := tencentyun.VerifyUserSig(
		1600000000,
		imSecret,
		importedUserID,
		*session.UserSig,
		time.Now(),
	); err != nil {
		t.Fatalf("VerifyUserSig() error = %v", err)
	}

	cancel()
	if code := <-result; code != 0 {
		t.Fatalf("serve code=%d stderr=%q", code, stderr.String())
	}
}

func TestServeCLICreatesTencentCommunityAndReturnsReadyServer(t *testing.T) {
	imported := make(chan string, 1)
	communityCreated := make(chan struct {
		GroupID string
		OwnerID string
	}, 1)
	tencentServer := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v4/im_open_login_svc/account_import":
			var body struct {
				UserID string `json:"UserID"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode account_import: %v", err)
			}
			imported <- body.UserID
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":""}`,
			)
		case "/v4/group_open_http_svc/create_group":
			var body struct {
				GroupID          string `json:"GroupId"`
				OwnerID          string `json:"Owner_Account"`
				Type             string `json:"Type"`
				SupportTopic     int    `json:"SupportTopic"`
				ApplyJoinOption  string `json:"ApplyJoinOption"`
				InviteJoinOption string `json:"InviteJoinOption"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode create_group: %v", err)
			}
			if body.Type != "Community" ||
				body.SupportTopic != 1 ||
				body.ApplyJoinOption != "DisableApply" ||
				body.InviteJoinOption != "DisableInvite" {
				t.Fatalf("create_group body = %#v", body)
			}
			communityCreated <- struct {
				GroupID string
				OwnerID string
			}{GroupID: body.GroupID, OwnerID: body.OwnerID}
			_, _ = io.WriteString(
				writer,
				`{"ActionStatus":"OK","ErrorCode":0,"ErrorInfo":"","GroupId":"`+
					body.GroupID+`"}`,
			)
		default:
			t.Fatalf("Tencent path = %s", request.URL.Path)
		}
	}))
	t.Cleanup(tencentServer.Close)

	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdout := newSignalBuffer("平台 API 与 IM Worker 已启动")
	var stderr bytes.Buffer
	result := make(chan int, 1)
	go func() {
		result <- Run(ctx, []string{
			"serve",
			"--database", filepath.Join(root, "data", "chatserver.db"),
			"--listen", "127.0.0.1:0",
			"--jwt-key-file", writeJWTKey(t, root, 0o600),
			"--im-sdk-app-id", "1600000000",
			"--im-admin-user-id", "platform_admin",
			"--im-secret-key-file", writeTextSecret(
				t,
				root,
				"im-secret.key",
				"local-test-im-secret-for-community",
				0o600,
			),
			"--im-identity-key-file", writeIdentityKey(t, root, 0o600),
			"--im-rest-base-url", tencentServer.URL,
			"--computer-install-public-url", "https://platform.example.test",
		}, stdout, &stderr)
	}()
	select {
	case <-stdout.signaled:
	case <-time.After(10 * time.Second):
		t.Fatalf("serve did not start; stderr=%q", stderr.String())
	}
	baseURL := startedBaseURL(t, stdout.String())

	registerRequest, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/v1/auth/register",
		strings.NewReader(
			`{"email":"owner@example.com","password":"password-123",`+
				`"displayName":"Owner"}`,
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	registerRequest.Header.Set("Content-Type", "application/json")
	registerResponse, err := http.DefaultClient.Do(registerRequest)
	if err != nil {
		t.Fatal(err)
	}
	var auth openapi.AuthResult
	if err := json.NewDecoder(registerResponse.Body).Decode(&auth); err != nil {
		t.Fatal(err)
	}
	_ = registerResponse.Body.Close()
	if registerResponse.StatusCode != http.StatusCreated ||
		auth.AccessToken == nil {
		t.Fatalf("register status/result = %d / %#v",
			registerResponse.StatusCode, auth)
	}
	var ownerIMUserID string
	select {
	case ownerIMUserID = <-imported:
	case <-time.After(5 * time.Second):
		t.Fatal("identity worker did not import owner")
	}
	waitForReadyMe(t, baseURL, *auth.AccessToken)

	createRequest, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/v1/servers",
		strings.NewReader(
			`{"slug":"agent-lab","name":"Agent 实验室",`+
				`"description":"Agent 协作空间"}`,
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	createRequest.Header.Set("Authorization", "Bearer "+*auth.AccessToken)
	createRequest.Header.Set("Content-Type", "application/json")
	createRequest.Header.Set("Idempotency-Key", "server-create-test-0001")
	createResponse, err := http.DefaultClient.Do(createRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer createResponse.Body.Close()
	if createResponse.StatusCode != http.StatusCreated {
		data, _ := io.ReadAll(createResponse.Body)
		t.Fatalf("create server status=%d body=%s",
			createResponse.StatusCode, data)
	}
	var created openapi.Server
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.ImState != "ready" || created.Revision != 2 {
		t.Fatalf("created Server = %#v", created)
	}
	select {
	case actual := <-communityCreated:
		if actual.OwnerID != ownerIMUserID ||
			actual.GroupID == "" {
			t.Fatalf("Community identity = %#v, owner=%q",
				actual, ownerIMUserID)
		}
	case <-time.After(time.Second):
		t.Fatal("Community call was not observed")
	}

	cancel()
	if code := <-result; code != 0 {
		t.Fatalf("serve code=%d stderr=%q", code, stderr.String())
	}
}

func waitForReadyMe(t *testing.T, baseURL string, accessToken string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		request, err := http.NewRequest(
			http.MethodGet,
			baseURL+"/v1/me",
			nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+accessToken)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		var account openapi.Account
		decodeErr := json.NewDecoder(response.Body).Decode(&account)
		_ = response.Body.Close()
		if response.StatusCode == http.StatusOK &&
			decodeErr == nil &&
			account.ImState == "ready" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET /me did not become ready: status=%d account=%#v err=%v",
				response.StatusCode, account, decodeErr)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type signalBuffer struct {
	mu       sync.Mutex
	buffer   bytes.Buffer
	needle   string
	signaled chan struct{}
	once     sync.Once
}

func newSignalBuffer(needle string) *signalBuffer {
	return &signalBuffer{
		needle:   needle,
		signaled: make(chan struct{}),
	}
}

func (buffer *signalBuffer) Write(data []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	written, err := buffer.buffer.Write(data)
	if strings.Contains(buffer.buffer.String(), buffer.needle) {
		buffer.once.Do(func() { close(buffer.signaled) })
	}
	return written, err
}

func (buffer *signalBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func TestServeCLIRequiresSafeJWTKeyFile(t *testing.T) {
	root := t.TempDir()
	keyPath := writeJWTKey(t, root, 0o644)
	imSecretPath := writeTextSecret(
		t,
		root,
		"im-secret.key",
		"local-test-im-secret",
		0o600,
	)
	var stdout, stderr bytes.Buffer

	code := Run(context.Background(), []string{
		"serve",
		"--database", filepath.Join(root, "data", "chatserver.db"),
		"--listen", "127.0.0.1:0",
		"--jwt-key-file", keyPath,
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", imSecretPath,
		"--im-identity-key-file", writeIdentityKey(t, root, 0o600),
	}, &stdout, &stderr)

	if code != 2 || !strings.Contains(stderr.String(), "CONFIG_INVALID") {
		t.Fatalf("unsafe key code=%d stderr=%q", code, stderr.String())
	}
}

func TestServeCLIRequiresJWTKeyFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"serve",
		"--database", filepath.Join(t.TempDir(), "data", "chatserver.db"),
	}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "CONFIG_INVALID") {
		t.Fatalf("missing key code=%d stderr=%q", code, stderr.String())
	}
}

func TestServeCLIRequiresCompleteIMConfiguration(t *testing.T) {
	root := t.TempDir()
	_, err := parseServeConfig([]string{
		"--database", filepath.Join(root, "data", "chatserver.db"),
		"--jwt-key-file", writeJWTKey(t, root, 0o600),
	})
	if err == nil {
		t.Fatal("parseServeConfig() accepted missing IM configuration")
	}
}

func TestServeCLIParsesOptionalTencentIMCallbackTokenFile(t *testing.T) {
	root := t.TempDir()
	tokenPath := filepath.Join(root, "im-callback.token")
	cfg, err := parseServeConfig([]string{
		"--database", filepath.Join(root, "data", "chatserver.db"),
		"--listen", "127.0.0.1:0",
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", filepath.Join(root, "im-secret.key"),
		"--im-identity-key-file", filepath.Join(root, "im-identity.key"),
		"--im-callback-token-file", tokenPath,
		"--computer-install-public-url", "https://platform.example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.imCallbackTokenFile != tokenPath {
		t.Fatalf("imCallbackTokenFile = %q", cfg.imCallbackTokenFile)
	}
}

func TestServeCLI支持显式TDSQLDSN文件(t *testing.T) {
	root := t.TempDir()
	dsnFile := filepath.Join(root, "mysql.dsn")
	cfg, err := parseServeConfig([]string{
		"--database-driver", "tdsql",
		"--database-dsn-file", dsnFile,
		"--database-auto-migrate=false",
		"--listen", "0.0.0.0:8080",
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", filepath.Join(root, "im-secret.key"),
		"--im-identity-key-file", filepath.Join(root, "im-identity.key"),
		"--computer-install-public-url", "https://platform.example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.database.Driver != config.DatabaseDriverTDSQL ||
		cfg.database.DSNFile != dsnFile || cfg.databaseAutoMigrate {
		t.Fatalf("serve TDSQL config = %#v", cfg.database)
	}
}

func TestLoadTextSecret接受Kubernetes只读挂载(t *testing.T) {
	root := t.TempDir()
	path := writeTextSecret(t, root, "mounted-secret", "safe-kubernetes-secret", 0o440)
	got, err := loadTextSecret(path, "测试密钥")
	if err != nil {
		t.Fatalf("loadTextSecret() error = %v", err)
	}
	if got != "safe-kubernetes-secret" {
		t.Fatalf("loadTextSecret() = %q", got)
	}
}

func TestServeCLI解析后台专属腾讯云凭据文件(t *testing.T) {
	root := t.TempDir()
	secretIDFile := filepath.Join(root, "secret-id")
	secretKeyFile := filepath.Join(root, "secret-key")
	baseArgs := []string{
		"--database", filepath.Join(root, "chatserver.db"),
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", filepath.Join(root, "im-secret.key"),
		"--im-identity-key-file", filepath.Join(root, "im-identity.key"),
		"--computer-install-public-url", "https://platform.example.test",
	}
	cfg, err := parseServeConfig(append(baseArgs,
		"--tencent-cloud-secret-id-file", secretIDFile,
		"--tencent-cloud-secret-key-file", secretKeyFile,
	))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.tencentCloudSecretIDFile != secretIDFile ||
		cfg.tencentCloudSecretKeyFile != secretKeyFile ||
		cfg.managedTATRegion != "ap-beijing" {
		t.Fatalf("腾讯云凭据配置 = %#v", cfg)
	}
	overridden, err := parseServeConfig(append(baseArgs,
		"--tencent-cloud-secret-id-file", secretIDFile,
		"--tencent-cloud-secret-key-file", secretKeyFile,
		"--managed-tat-region", "ap-shanghai",
	))
	if err != nil || overridden.managedTATRegion != "ap-shanghai" {
		t.Fatalf("托管 TAT 地域覆盖 = (%#v, %v)", overridden, err)
	}
	if _, err := parseServeConfig(append(baseArgs,
		"--tencent-cloud-secret-id-file", secretIDFile,
	)); err == nil {
		t.Fatal("parseServeConfig() accepted incomplete Tencent Cloud credential files")
	}
}

func TestServeCLI要求ComputerRelease和私有桶配置成组出现(t *testing.T) {
	root := t.TempDir()
	baseArgs := []string{
		"--database", filepath.Join(root, "chatserver.db"),
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", filepath.Join(root, "im-secret.key"),
		"--im-identity-key-file", filepath.Join(root, "im-identity.key"),
		"--computer-install-public-url", "https://platform.example.test",
		"--tencent-cloud-secret-id-file", filepath.Join(root, "secret-id"),
		"--tencent-cloud-secret-key-file", filepath.Join(root, "secret-key"),
	}
	cfg, err := parseServeConfig(append(baseArgs,
		"--computer-release-file", filepath.Join(root, "computer-release.json"),
		"--computer-artifact-bucket", "an-computer-1388575217",
		"--computer-artifact-region", "ap-beijing",
	))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.computerReleaseFile == "" || cfg.computerArtifactBucket != "an-computer-1388575217" ||
		cfg.computerArtifactRegion != "ap-beijing" {
		t.Fatalf("Computer release config = %#v", cfg)
	}
	if _, err := parseServeConfig(append(baseArgs,
		"--computer-release-file", filepath.Join(root, "computer-release.json"),
	)); err == nil {
		t.Fatal("parseServeConfig() accepted incomplete Computer artifact configuration")
	}
}

func TestServeCLI解析独立Computer内网HTTP安装地址(t *testing.T) {
	root := t.TempDir()
	baseArgs := []string{
		"--database", filepath.Join(root, "chatserver.db"),
		"--jwt-key-file", filepath.Join(root, "jwt.key"),
		"--im-sdk-app-id", "1600000000",
		"--im-admin-user-id", "platform_admin",
		"--im-secret-key-file", filepath.Join(root, "im-secret.key"),
		"--im-identity-key-file", filepath.Join(root, "im-identity.key"),
		"--computer-install-public-url", "https://platform.example.test",
		"--tencent-cloud-secret-id-file", filepath.Join(root, "secret-id"),
		"--tencent-cloud-secret-key-file", filepath.Join(root, "secret-key"),
		"--computer-release-file", filepath.Join(root, "computer-release.json"),
		"--computer-artifact-bucket", "an-computer-1388575217",
		"--computer-artifact-region", "ap-beijing",
	}
	remoteHTTP := append(append([]string{}, baseArgs...),
		"--computer-install-public-url", "http://9.135.236.64/",
	)
	if _, err := parseServeConfig(remoteHTTP); err == nil {
		t.Fatal("parseServeConfig() accepted remote Computer HTTP without explicit opt-in")
	}
	cfg, err := parseServeConfig(append(remoteHTTP, "--allow-insecure-computer-install-http"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.computerInstallPublicURL != "http://9.135.236.64" ||
		!cfg.allowInsecureComputerInstallHTTP {
		t.Fatalf("Computer HTTP config = %#v", cfg)
	}
	httpsConfig, err := parseServeConfig(baseArgs)
	if err != nil {
		t.Fatal(err)
	}
	if httpsConfig.computerInstallPublicURL != "https://platform.example.test" ||
		httpsConfig.allowInsecureComputerInstallHTTP {
		t.Fatalf("Computer HTTPS config = %#v", httpsConfig)
	}
	if _, err := parseServeConfig(append(append([]string{}, baseArgs...),
		"--allow-insecure-computer-install-http",
	)); err == nil {
		t.Fatal("parseServeConfig() accepted unused insecure HTTP opt-in")
	}
}

func TestServeCLIRejectsUnsafeIMSecretFile(t *testing.T) {
	root := t.TempDir()
	path := writeTextSecret(
		t,
		root,
		"im-secret.key",
		"local-test-im-secret",
		0o644,
	)
	if _, err := loadTextSecret(path, "腾讯云 IM 密钥"); err == nil {
		t.Fatal("loadTextSecret() accepted mode 0644")
	}
}

func writeJWTKey(
	t *testing.T,
	root string,
	mode os.FileMode,
) string {
	t.Helper()
	path := filepath.Join(root, "jwt.key")
	value := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x42}, 32))
	if err := os.WriteFile(path, []byte(value+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeIdentityKey(
	t *testing.T,
	root string,
	mode os.FileMode,
) string {
	t.Helper()
	path := filepath.Join(root, "im-identity.key")
	value := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x24}, 32))
	if err := os.WriteFile(path, []byte(value+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeTextSecret(
	t *testing.T,
	root string,
	name string,
	value string,
	mode os.FileMode,
) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte(value+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

func startedBaseURL(t *testing.T, output string) string {
	t.Helper()
	const marker = "平台 API 与 IM Worker 已启动：http://"
	index := strings.Index(output, marker)
	if index < 0 {
		t.Fatalf("start output = %q", output)
	}
	address := strings.TrimSpace(output[index+len(marker):])
	if newline := strings.IndexByte(address, '\n'); newline >= 0 {
		address = address[:newline]
	}
	return "http://" + address
}
