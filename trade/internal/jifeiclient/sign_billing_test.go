package jifeiclient

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// TestSignBillingEnvelope_AlgorithmSteps 通过逐步重算每一步的中间值，验证 signBillingEnvelope
// 实现严格符合 .tmp/jifei_pdf_txt/计费网关-接入和签名算法.txt §签名算法 4 步：
//
//  1. req = upper(md5(interface JSON utf8 - auth))
//  2. stringA = ASCII 字典序拼接 key=value, '&' 分隔
//  3. stringB = stringA + "&appSecret=" + appSecret
//  4. signature = upper(hmac_sha256(stringB, appSecret) hex)
func TestSignBillingEnvelope_AlgorithmSteps(t *testing.T) {
	const (
		appID     = "lighthouse_v1"
		appSecret = "IDC1LD9L1BQJTCK45TNKXBXF"
		nonce     = "abc-123"
		ts        = int64(1779600000)
	)

	paraJSON := json.RawMessage(`{"foo":"bar","n":1}`)
	iface := &interfaceBlock{
		InterfaceName: "qcloud.operation.ModifyResourceStatus",
		Para:          paraJSON,
	}

	gotAuth, err := signBillingEnvelope(appID, appSecret, ts, nonce, iface)
	if err != nil {
		t.Fatalf("signBillingEnvelope: %v", err)
	}

	// Step 1 重算: req = upper(md5(interface JSON utf8 - auth))
	ifaceBytes, err := json.Marshal(iface)
	if err != nil {
		t.Fatalf("marshal iface: %v", err)
	}
	if strings.Contains(string(ifaceBytes), `"auth"`) {
		t.Fatalf("interface JSON should NOT contain auth field at step 1: %s", ifaceBytes)
	}
	md5Sum := md5.Sum(ifaceBytes)
	wantReq := strings.ToUpper(hex.EncodeToString(md5Sum[:]))

	// Step 2 重算: stringA
	params := map[string]string{
		"appid":     appID,
		"nonce":     nonce,
		"req":       wantReq,
		"timestamp": "1779600000",
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	stringA := strings.Join(parts, "&")

	// 字典序硬断言：appid < nonce < req < timestamp
	if stringA != "appid="+appID+"&nonce="+nonce+"&req="+wantReq+"&timestamp=1779600000" {
		t.Errorf("stringA dictionary order broken: %s", stringA)
	}

	// Step 3 重算: stringB
	stringB := stringA + "&appSecret=" + appSecret

	// Step 4 重算: signature
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(stringB))
	wantSig := strings.ToUpper(hex.EncodeToString(mac.Sum(nil)))

	if gotAuth.AppID != appID {
		t.Errorf("auth.AppID: got %q want %q", gotAuth.AppID, appID)
	}
	if gotAuth.Nonce != nonce {
		t.Errorf("auth.Nonce: got %q want %q", gotAuth.Nonce, nonce)
	}
	if gotAuth.Timestamp != "1779600000" {
		t.Errorf("auth.Timestamp: got %q want %q", gotAuth.Timestamp, "1779600000")
	}
	if gotAuth.Signature != wantSig {
		t.Errorf("auth.Signature mismatch:\n got  %s\n want %s", gotAuth.Signature, wantSig)
	}

	// 大写 hex 形式断言 (HMAC-SHA256 = 32 字节 = 64 hex 字符；PDF §3 示例最终签名 64 字符)
	if len(gotAuth.Signature) != 64 {
		t.Errorf("signature length: got %d want 64", len(gotAuth.Signature))
	}
	for _, ch := range gotAuth.Signature {
		if !((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F')) {
			t.Errorf("signature contains non-uppercase-hex char %q in %s", ch, gotAuth.Signature)
			break
		}
	}
}

// TestSignBillingEnvelope_StableForSamePayload 验证：同一 (appID, secret, ts, nonce, iface)
// 输入下 signature 必须可重现 — HMAC-SHA256 是确定性算法，签名服务侧能够独立重算并校验。
func TestSignBillingEnvelope_StableForSamePayload(t *testing.T) {
	iface := &interfaceBlock{
		InterfaceName: "qcloud.operation.ModifyResourceStatus",
		Para:          json.RawMessage(`{"a":1}`),
	}
	a1, err := signBillingEnvelope("appid_x", "secret_y", 100, "n1", iface)
	if err != nil {
		t.Fatalf("first sign: %v", err)
	}
	// 注意：必须重新构造一个干净的 iface（前一次调用并不会污染 iface.Auth — 工具函数只返回 *billingAuth）
	iface2 := &interfaceBlock{
		InterfaceName: iface.InterfaceName,
		Para:          iface.Para,
	}
	a2, err := signBillingEnvelope("appid_x", "secret_y", 100, "n1", iface2)
	if err != nil {
		t.Fatalf("second sign: %v", err)
	}
	if a1.Signature != a2.Signature {
		t.Errorf("signature not stable across calls: %s vs %s", a1.Signature, a2.Signature)
	}
}

// TestSignBillingEnvelope_DifferentForDifferentSecret 验证密钥变化导致签名变化 — 防止
// 实现退化为忽略 secret（如错误地走 plain SHA256(stringB) 而非 HMAC）。
func TestSignBillingEnvelope_DifferentForDifferentSecret(t *testing.T) {
	iface := &interfaceBlock{
		InterfaceName: "x",
		Para:          json.RawMessage(`{}`),
	}
	a1, err := signBillingEnvelope("appid", "secret-A", 1, "n", iface)
	if err != nil {
		t.Fatalf("a1: %v", err)
	}
	iface2 := &interfaceBlock{InterfaceName: "x", Para: json.RawMessage(`{}`)}
	a2, err := signBillingEnvelope("appid", "secret-B", 1, "n", iface2)
	if err != nil {
		t.Fatalf("a2: %v", err)
	}
	if a1.Signature == a2.Signature {
		t.Errorf("signature should differ for different secret, both = %s", a1.Signature)
	}
}

// TestSignBillingEnvelope_RejectsInvalidArgs 验证 client-side 入参缺失校验。
func TestSignBillingEnvelope_RejectsInvalidArgs(t *testing.T) {
	iface := &interfaceBlock{InterfaceName: "x", Para: json.RawMessage(`{}`)}

	cases := []struct {
		name      string
		appID     string
		secret    string
		nonce     string
		iface     *interfaceBlock
		errSubstr string
	}{
		{"nil iface", "a", "s", "n", nil, "nil interface block"},
		{"empty appID", "", "s", "n", iface, "empty appID"},
		{"empty secret", "a", "", "n", iface, "empty appID or appSecret"},
		{"empty nonce", "a", "s", "", iface, "empty nonce"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := signBillingEnvelope(tc.appID, tc.secret, 1, tc.nonce, tc.iface)
			if err == nil || !strings.Contains(err.Error(), tc.errSubstr) {
				t.Errorf("err = %v, want containing %q", err, tc.errSubstr)
			}
		})
	}
}

// TestRandomNonce_HexAndLength 验证默认 nonce 生成器形态稳定（16 字符 hex，便于联调期日志识别）。
func TestRandomNonce_HexAndLength(t *testing.T) {
	n := randomNonce()
	if len(n) != 16 {
		t.Errorf("nonce length: got %d want 16", len(n))
	}
	for _, ch := range n {
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
			t.Errorf("nonce contains non-lowercase-hex char %q in %s", ch, n)
			break
		}
	}
}
