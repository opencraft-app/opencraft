//go:build canary

package integration

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tokenadapter "chatserver/internal/adapters/token"
	clockport "chatserver/internal/ports/clock"
	tokenport "chatserver/internal/ports/token"
)

func TestRenewLiveHumanAccessToken(t *testing.T) {
	if os.Getenv("CHATSERVER_RUN_LIVE_TOKEN_RENEWAL") != "1" {
		t.Skip("仅在显式启用真实 Human Token 续签时运行")
	}
	oldTokenPath := requireLiveValue(
		t,
		"CHATSERVER_LIVE_OLD_ACCESS_TOKEN_FILE",
	)
	keyPath := requireLiveValue(t, "CHATSERVER_LIVE_JWT_KEY_FILE")
	outputTokenPath := requireLiveValue(
		t,
		"CHATSERVER_LIVE_NEW_ACCESS_TOKEN_FILE",
	)
	outputHeaderPath := requireLiveValue(
		t,
		"CHATSERVER_LIVE_NEW_AUTHORIZATION_HEADER_FILE",
	)

	oldToken := readLiveToken(t, oldTokenPath)
	key := readLiveJWTKey(t, keyPath)
	historicalSigner, err := tokenadapter.NewHMACJWT(
		key,
		fixedLiveClock{now: time.Unix(1, 0).UTC()},
	)
	if err != nil {
		t.Fatal("创建历史 Token 验证器失败")
	}
	claims, err := historicalSigner.Verify(context.Background(), oldToken)
	if err != nil || claims.Kind() != tokenport.ClaimsHumanAccess {
		t.Fatal("旧 Human Token 签名或声明无效")
	}

	now := clockport.System{}.Now().UTC()
	renewedClaims, err := tokenport.NewHumanClaims(
		claims.AccountID(),
		claims.SessionID(),
		claims.Version(),
		now,
		now.Add(15*time.Minute),
	)
	if err != nil {
		t.Fatal("创建续签声明失败")
	}
	currentSigner, err := tokenadapter.NewHMACJWT(key, clockport.System{})
	if err != nil {
		t.Fatal("创建当前 Token 签发器失败")
	}
	renewedToken, err := currentSigner.Sign(
		context.Background(),
		renewedClaims,
	)
	if err != nil {
		t.Fatal("续签 Human Token 失败")
	}
	if _, err := currentSigner.Verify(
		context.Background(),
		renewedToken,
	); err != nil {
		t.Fatal("续签 Human Token 自验证失败")
	}

	atomicWriteLiveSecret(t, outputTokenPath, renewedToken+"\n")
	atomicWriteLiveSecret(
		t,
		outputHeaderPath,
		"Authorization: Bearer "+renewedToken+"\n",
	)
	t.Log("Human access token 已续签并写入受限文件")
}

func requireLiveValue(t *testing.T, name string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		t.Fatalf("缺少真实验收配置 %s", name)
	}
	return value
}

func readLiveToken(t *testing.T, path string) string {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil ||
		!info.Mode().IsRegular() ||
		info.Mode().Perm()&0o077 != 0 {
		t.Fatal("Token 文件无效或权限过宽")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("读取 Token 失败")
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		t.Fatal("Token 文件为空")
	}
	return token
}

type fixedLiveClock struct {
	now time.Time
}

func (clock fixedLiveClock) Now() time.Time {
	return clock.now
}

func readLiveJWTKey(t *testing.T, path string) []byte {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil ||
		!info.Mode().IsRegular() ||
		info.Mode().Perm()&0o077 != 0 {
		t.Fatal("JWT Key 文件无效或权限过宽")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("读取 JWT Key 失败")
	}
	encoded := strings.TrimSpace(string(data))
	decoders := []*base64.Encoding{
		base64.RawURLEncoding.Strict(),
		base64.URLEncoding.Strict(),
		base64.RawStdEncoding.Strict(),
		base64.StdEncoding.Strict(),
	}
	for _, decoder := range decoders {
		key, decodeErr := decoder.DecodeString(encoded)
		if decodeErr == nil && len(key) >= 32 {
			return key
		}
	}
	t.Fatal("JWT Key 格式无效")
	return nil
}

func atomicWriteLiveSecret(
	t *testing.T,
	path string,
	value string,
) {
	t.Helper()
	directory := filepath.Dir(path)
	temp, err := os.CreateTemp(directory, ".live-secret-*.tmp")
	if err != nil {
		t.Fatal("创建 Secret 临时文件失败")
	}
	tempPath := temp.Name()
	closed := false
	t.Cleanup(func() {
		if !closed {
			_ = temp.Close()
		}
		_ = os.Remove(tempPath)
	})
	if err := temp.Chmod(0o600); err != nil {
		t.Fatal("设置 Secret 临时文件权限失败")
	}
	if _, err := temp.WriteString(value); err != nil {
		t.Fatal("写入 Secret 临时文件失败")
	}
	if err := temp.Sync(); err != nil {
		t.Fatal("同步 Secret 临时文件失败")
	}
	if err := temp.Close(); err != nil {
		t.Fatal("关闭 Secret 临时文件失败")
	}
	closed = true
	if err := os.Rename(tempPath, path); err != nil {
		t.Fatal("原子替换 Secret 文件失败")
	}
}
