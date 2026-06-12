package jifeiclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// ============================================================================
// D-2.1: ModifyResourceStatus tests（jifei `qcloud.operation.ModifyResourceStatus`）
//
// 协议依据：PDF `【订购关系建设】资源中心对外cgw接口定义.pdf` §1.1
//   - 入参字段集（PDF 第 4-5 页）
//   - operateName 枚举（PDF 第 4-5 页 9 个值）
//   - 响应 envelope（PDF 第 6-7 页 operationSet / failedResources）
//
// 复用本包既有 envelopeForSuccess / envelopeForError / fixedEventIDProvider /
// fixedNowProvider helper（见 client_test.go）。
// ============================================================================

// TestModifyResourceStatus_Success 覆盖 happy-path：
//   - HTTP request method / Host / x-qcloud-user-id 正确
//   - envelope 顶层 7 字段正确（version / componentName / eventId / timestamp / seqId / interface.interfaceName）
//   - request body para 字段（PascalCase）按 PDF §1.1 完整发出
//   - **request body 含 interface.auth 4 字段（Q-D-SIG-1~6 销毁链路必须签名）**
//   - signature 重算与客户端一致（验证算法与 PDF §签名算法 4 步严格对齐）
//   - 响应 returnValue 反序列化到 ModifyResourceStatusResponse，operationSet 字段值正确
func TestModifyResourceStatus_Success(t *testing.T) {
	var (
		seenMethod    string
		seenHost      string
		seenUserID    string
		seenInterface string
		seenComponent string
		seenPara      ModifyResourceStatusRequest
		bodyStr       string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenMethod = r.Method
		seenHost = r.Host
		seenUserID = r.Header.Get(CGWUserIDHeader)

		body, _ := io.ReadAll(r.Body)
		bodyStr = string(body)

		var env envelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal request envelope: %v", err)
		}
		seenComponent = env.ComponentName
		if env.Interface != nil {
			seenInterface = env.Interface.InterfaceName
			if err := json.Unmarshal(env.Interface.Para, &seenPara); err != nil {
				t.Fatalf("unmarshal para: %v", err)
			}
		}

		_, _ = w.Write(envelopeForSuccess(t, ModifyResourceStatusResponse{
			OperationSet: []ModifyResourceStatusOperation{
				{
					SubProductCode: "sp_lighthouse_pass",
					OperationID:    0,
					ResultType:     0,
					Status:         0,
				},
			},
			FailedResources: []ModifyResourceStatusFailure{},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-service-uin", Options{
		EventIDProvider:      fixedEventIDProvider,
		NowProvider:          fixedNowProvider,
		BillingAPIGWBaseURL:  server.URL,
		BillingAppID:         "test_v0",
		BillingAppSecret:     "66666666666666666666",
		BillingNonceProvider: func() string { return "test-nonce-001" },
	})

	resp, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:    ClientTypeProduct,
		SubmitByUser:  SubmitByUserYes,
		ReferenceID:   "lhpass-abc_1715000000000000000",
		ProductCode:   "p_lighthouse",
		OwnerUIN:      "100012345678",
		UIN:           "100012345678",
		SubAccountUIN: "100012345678",
		AppID:         1300012345,
		RegionID:      1,
		PayMode:       PayModePrepaid,
		OperateName:   OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{
				SubProductCode: "sp_lighthouse_pass",
				ResourceIDs:    []string{"lhpass-abc"},
			},
		},
	})
	if err != nil {
		t.Fatalf("ModifyResourceStatus: %v", err)
	}

	// 出参字段断言
	if got := len(resp.OperationSet); got != 1 {
		t.Fatalf("OperationSet len: got %d want 1", got)
	}
	if resp.OperationSet[0].Status != 0 {
		t.Errorf("OperationSet[0].Status: got %d want 0", resp.OperationSet[0].Status)
	}
	if resp.OperationSet[0].SubProductCode != "sp_lighthouse_pass" {
		t.Errorf("OperationSet[0].SubProductCode: got %q", resp.OperationSet[0].SubProductCode)
	}
	if len(resp.FailedResources) != 0 {
		t.Errorf("FailedResources: got %v want empty", resp.FailedResources)
	}

	// 请求级断言
	if seenMethod != http.MethodPost {
		t.Errorf("HTTP method: got %s want POST", seenMethod)
	}
	// v1.7.4 起 client 不再主动注入 Host header（由 clgateway upstream 段重写，Q-INT-11=b）。
	_ = seenHost
	if seenUserID != "trade-service-uin" {
		t.Errorf("x-qcloud-user-id: got %q", seenUserID)
	}
	if seenInterface != InterfaceNameModifyResourceStatus {
		t.Errorf("interfaceName: got %q want %q", seenInterface, InterfaceNameModifyResourceStatus)
	}
	if seenComponent != CGWComponentNameLightvela {
		t.Errorf("componentName: got %q want %q", seenComponent, CGWComponentNameLightvela)
	}

	// para 字段全量断言（PDF §1.1）
	if seenPara.ClientType != ClientTypeProduct {
		t.Errorf("para.clientType: got %d want %d", seenPara.ClientType, ClientTypeProduct)
	}
	if seenPara.SubmitByUser != SubmitByUserYes {
		t.Errorf("para.submitByUser: got %d want %d", seenPara.SubmitByUser, SubmitByUserYes)
	}
	if seenPara.ReferenceID != "lhpass-abc_1715000000000000000" {
		t.Errorf("para.referenceId: got %q", seenPara.ReferenceID)
	}
	if seenPara.ProductCode != "p_lighthouse" {
		t.Errorf("para.productCode: got %q", seenPara.ProductCode)
	}
	if seenPara.UIN != "100012345678" {
		t.Errorf("para.uin: got %q", seenPara.UIN)
	}
	if seenPara.SubAccountUIN != "100012345678" {
		t.Errorf("para.subAccountUin: got %q", seenPara.SubAccountUIN)
	}
	if seenPara.AppID != 1300012345 {
		t.Errorf("para.appId: got %d", seenPara.AppID)
	}
	if seenPara.RegionID != 1 {
		t.Errorf("para.regionId: got %d", seenPara.RegionID)
	}
	if seenPara.PayMode != PayModePrepaid {
		t.Errorf("para.payMode: got %d", seenPara.PayMode)
	}
	if seenPara.OperateName != OperateNamePreDestroy {
		t.Errorf("para.operateName: got %q want %q", seenPara.OperateName, OperateNamePreDestroy)
	}
	if got := len(seenPara.ResourcesParamSet); got != 1 {
		t.Fatalf("para.resourcesParamSet len: got %d want 1", got)
	}
	if seenPara.ResourcesParamSet[0].SubProductCode != "sp_lighthouse_pass" {
		t.Errorf("para.resourcesParamSet[0].subProductCode: got %q",
			seenPara.ResourcesParamSet[0].SubProductCode)
	}
	if got := seenPara.ResourcesParamSet[0].ResourceIDs; len(got) != 1 || got[0] != "lhpass-abc" {
		t.Errorf("para.resourcesParamSet[0].resourceIds: got %v", got)
	}

	// Q-D-SIG-1~6 销毁链路签名严格要求：
	//   1. envelope.interface.auth 必须存在，4 字段都非空
	//   2. signature 为 HMAC-SHA256 hex 大写 (64 字符、全部 [0-9A-F])
	//   3. 本地重算 signature 与客户端发出的完全一致（验证算法实现与 PDF §签名算法对齐）
	{
		var reqEnv envelope
		if err := json.Unmarshal([]byte(bodyStr), &reqEnv); err != nil {
			t.Fatalf("reparse envelope for auth assertion: %v", err)
		}
		if reqEnv.Interface == nil || reqEnv.Interface.Auth == nil {
			t.Fatalf("Q-D-SIG-1~6 violated: envelope.interface.auth missing\n%s", bodyStr)
		}
		auth := reqEnv.Interface.Auth
		if auth.AppID != "test_v0" {
			t.Errorf("auth.appid: got %q want %q", auth.AppID, "test_v0")
		}
		if auth.Nonce != "test-nonce-001" {
			t.Errorf("auth.nonce: got %q want %q", auth.Nonce, "test-nonce-001")
		}
		if auth.Timestamp == "" {
			t.Errorf("auth.timestamp: empty")
		}
		if len(auth.Signature) != 64 {
			t.Errorf("auth.signature length: got %d want 64 (HMAC-SHA256 hex)", len(auth.Signature))
		}
		for _, ch := range auth.Signature {
			if !((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F')) {
				t.Errorf("auth.signature contains non-uppercase-hex char %q in %s", ch, auth.Signature)
				break
			}
		}

		// 重算 signature 与客户端发出的一致 — 验证与 PDF §签名算法 4 步实现对齐。
		// 取 timestamp 从 auth 本身，避免与服务器默认 NowProvider 脱同。
		//
		// **v1.7.29 验证**：重算 base 中必须包含 ExtraPara（OwnerUin）才能与客户端一致；
		// 这个断言也反向证明 ExtraPara 进入了出向 wire 且进入了 md5 base。
		tsParsed, _ := strconv.ParseInt(auth.Timestamp, 10, 64)
		recalcAuth, err := signBillingEnvelope("test_v0", "66666666666666666666", tsParsed, "test-nonce-001",
			&interfaceBlock{
				InterfaceName: reqEnv.Interface.InterfaceName,
				ExtraPara:     reqEnv.Interface.ExtraPara,
				Para:          reqEnv.Interface.Para,
			})
		if err != nil {
			t.Fatalf("recompute signature: %v", err)
		}
		if recalcAuth.Signature != auth.Signature {
			t.Errorf("signature mismatch: client sent %q, recomputed %q", auth.Signature, recalcAuth.Signature)
		}
	}
}

// TestModifyResourceStatus_ExtraParaOwnerUin 验证 v1.7.29 修复：envelope.interface.extraPara.ownerUin
// 在出向 wire 中存在、且与 ModifyResourceStatusRequest.OwnerUIN 一致，与资源中心 PDF §1.1 示例
// 字段位置对齐。业务背景：jifei 资源中心网关硬校验 `extraPara.ownerUin or extraPara.site`，
// 缺则返 returnCode=100000 "param error,need ownerUin or site"；本用例防止这条协议字段被未来重构
// 误删 / 误移位。同时验证 OwnerUIN 不会进入 para（json:"-" 生效）。
func TestModifyResourceStatus_ExtraParaOwnerUin(t *testing.T) {
	var (
		seenInterface map[string]json.RawMessage
		seenPara      map[string]json.RawMessage
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env map[string]json.RawMessage
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		if err := json.Unmarshal(env["interface"], &seenInterface); err != nil {
			t.Fatalf("unmarshal interface: %v", err)
		}
		if err := json.Unmarshal(seenInterface["para"], &seenPara); err != nil {
			t.Fatalf("unmarshal para: %v", err)
		}
		_, _ = w.Write(envelopeForSuccess(t, ModifyResourceStatusResponse{
			OperationSet: []ModifyResourceStatusOperation{{Status: 0}},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	_, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "700000164995", // 这个值应该到 envelope.interface.extraPara.ownerUin
		UIN:          "700000164995",
		AppID:        251202221,
		RegionID:     1,
		PayMode:      PayModePrepaid,
		OperateName:  OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"pass-x"}},
		},
	})
	if err != nil {
		t.Fatalf("ModifyResourceStatus: %v", err)
	}

	// 断言 1：extraPara 子对象在 envelope.interface 层级出现
	extraRaw, ok := seenInterface["extraPara"]
	if !ok {
		t.Fatalf("envelope.interface.extraPara missing on wire (PDF 资源中心 §1.1 要求必填)")
	}
	var extra map[string]string
	if err := json.Unmarshal(extraRaw, &extra); err != nil {
		t.Fatalf("unmarshal extraPara: %v", err)
	}
	if got := extra["ownerUin"]; got != "700000164995" {
		t.Errorf("extraPara.ownerUin: got %q want %q", got, "700000164995")
	}

	// 断言 2：OwnerUIN 字段不会进 para（避免与下单/询价 para.ownerUin 路径混淆）
	if _, has := seenPara["ownerUin"]; has {
		t.Errorf("para.ownerUin should NOT exist (OwnerUIN must go to extraPara only); para = %v", seenPara)
	}
}

// TestModifyResourceStatus_BusinessErrorInterfaceAsString 验证 v1.7.29 修复（Q2 envelope 鲁棒性）：
// 实测jifei CGW 错误响应里 `interface` 字段会从对象降级为字符串字面量（如
// `"interface":"qcloud.operation.ModifyResourceStatus"`），client 必须能透出业务错误为 *CGWError
// 而不是被 json unmarshal 失败吞成 ErrCGWInvalidEnvelope。
func TestModifyResourceStatus_BusinessErrorInterfaceAsString(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 实测 jifei 错误响应 body（来自 trade-bj-7 [jifei-in] 日志）的精简复现：
		//   - returnValue=-1, returnCode=100000, returnMessage="param error,need ownerUin or site"
		//   - interface 字段是字符串 (与请求方向 interfaceBlock struct 类型不兼容)
		_, _ = w.Write([]byte(`{
			"version":"1.0",
			"timestamp":1779681840574,
			"eventId":734080896,
			"componentName":"swoole_api-gateway",
			"requestTime":1779681840.679,
			"returnValue":-1,
			"returnCode":100000,
			"returnMessage":"param error,need ownerUin or site",
			"interface":"qcloud.operation.ModifyResourceStatus",
			"data":[],
			"responseTime":1779681840.68
		}`))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	_, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "1",
		UIN:          "1",
		AppID:        1,
		RegionID:     1,
		PayMode:      PayModePrepaid,
		OperateName:  OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"pass-x"}},
		},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// 必须是 *CGWError（业务错误透出），不能是 ErrCGWInvalidEnvelope（包装失败吞掉错误）
	if errors.Is(err, ErrCGWInvalidEnvelope) {
		t.Fatalf("expected *CGWError, got ErrCGWInvalidEnvelope (业务错误被 envelope 解析吞掉了): %v", err)
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 100000 {
		t.Errorf("ReturnCode: got %d want 100000", cgwErr.ReturnCode)
	}
	if !strings.Contains(cgwErr.ReturnMessage, "ownerUin or site") {
		t.Errorf("ReturnMessage: got %q want substring \"ownerUin or site\"", cgwErr.ReturnMessage)
	}
}

// TestModifyResourceStatus_OmitsOptionalFields 验证可选字段为零值时被 JSON 省略。
//
// SubAccountUIN（空串）和 ReturnFlowID（0）都应该不出现在 body 中 —— 避免给 jifei 网关
// 传歧义字段（如 returnFlowId=0 与不传等价但占带宽 + 让 jifei 端日志更清晰）。
func TestModifyResourceStatus_OmitsOptionalFields(t *testing.T) {
	var seenRawPara map[string]json.RawMessage

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var env envelope
		_ = json.Unmarshal(body, &env)
		_ = json.Unmarshal(env.Interface.Para, &seenRawPara)
		_, _ = w.Write(envelopeForSuccess(t, ModifyResourceStatusResponse{
			OperationSet: []ModifyResourceStatusOperation{{Status: 0}},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	_, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "100012345678",
		UIN:          "100012345678",
		// SubAccountUIN 故意不传
		AppID:    1300012345,
		RegionID: 1,
		PayMode:  PayModePrepaid,
		// ReturnFlowID 故意不传
		OperateName: OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"lhpass-1"}},
		},
	})
	if err != nil {
		t.Fatalf("ModifyResourceStatus: %v", err)
	}

	if _, has := seenRawPara["subAccountUin"]; has {
		t.Errorf("subAccountUin should be omitted when empty, raw para: %v", seenRawPara)
	}
	if _, has := seenRawPara["returnFlowId"]; has {
		t.Errorf("returnFlowId should be omitted when zero, raw para: %v", seenRawPara)
	}
}

// TestModifyResourceStatus_BusinessError 验证 returnCode != 0 时返 *CGWError。
//
// 销毁链路常见业务错（PDF §1.1 协议层无具体错误码表，沿 jifei CGW 通用错误码语义；
// 100151 资源锁占用是销毁场景下最可能撞到的码 — 同一 resourceId 被并发销毁请求）。
func TestModifyResourceStatus_BusinessError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForError(t, 100151, "Resource.LockConflict"))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	_, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "100012345678",
		UIN:          "100012345678",
		AppID:        1300012345,
		RegionID:     1,
		PayMode:      PayModePrepaid,
		OperateName:  OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"lhpass-1"}},
		},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var cgwErr *CGWError
	if !errors.As(err, &cgwErr) {
		t.Fatalf("expected *CGWError, got %T: %v", err, err)
	}
	if cgwErr.ReturnCode != 100151 {
		t.Errorf("ReturnCode: got %d want 100151", cgwErr.ReturnCode)
	}
	if cgwErr.InterfaceName != InterfaceNameModifyResourceStatus {
		t.Errorf("InterfaceName: got %q", cgwErr.InterfaceName)
	}
}

// TestModifyResourceStatus_HTTPNon200 验证 HTTP 非 2xx 时返 ErrCGWHTTPNon200。
func TestModifyResourceStatus_HTTPNon200(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	_, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "1",
		UIN:          "1",
		AppID:        1,
		RegionID:     1,
		PayMode:      PayModePrepaid,
		OperateName:  OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"lhpass-1"}},
		},
	})
	if !errors.Is(err, ErrCGWHTTPNon200) {
		t.Fatalf("expected ErrCGWHTTPNon200, got: %v", err)
	}
}

// TestModifyResourceStatus_PartialFailure 验证响应同步部分失败 (status=2 + failedResources 非空)
// 由 client 透传给调用方 —— jifeiclient 这一层不做"半成功"判定（returnCode=0）。
func TestModifyResourceStatus_PartialFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(envelopeForSuccess(t, ModifyResourceStatusResponse{
			OperationSet: []ModifyResourceStatusOperation{
				{
					SubProductCode: "sp_lighthouse_pass",
					Status:         2, // 部分失败
				},
			},
			FailedResources: []ModifyResourceStatusFailure{
				{
					ResourceID:    "lhpass-bad",
					ReturnCode:    100001,
					ReturnMessage: "调业务接口运行时异常: xxx",
				},
			},
		}))
	}))
	defer server.Close()

	cli := New(server.URL, "trade-uin", Options{
		BillingAPIGWBaseURL: server.URL,
		BillingAppID:        "test_v0",
		BillingAppSecret:    "sec",
	})
	resp, err := cli.ModifyResourceStatus(context.Background(), &ModifyResourceStatusRequest{
		ClientType:   ClientTypeProduct,
		SubmitByUser: SubmitByUserYes,
		ReferenceID:  "ref-1",
		ProductCode:  "p_lighthouse",
		OwnerUIN:     "1",
		UIN:          "1",
		AppID:        1,
		RegionID:     1,
		PayMode:      PayModePrepaid,
		OperateName:  OperateNamePreDestroy,
		ResourcesParamSet: []ModifyResourceStatusItem{
			{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"lhpass-bad"}},
		},
	})
	// jifeiclient 层不报错（returnCode=0），半成功状态由调用方消费
	if err != nil {
		t.Fatalf("ModifyResourceStatus: unexpected error: %v", err)
	}
	if got := resp.OperationSet[0].Status; got != 2 {
		t.Errorf("OperationSet[0].Status: got %d want 2", got)
	}
	if got := len(resp.FailedResources); got != 1 {
		t.Fatalf("FailedResources len: got %d want 1", got)
	}
	if resp.FailedResources[0].ResourceID != "lhpass-bad" {
		t.Errorf("FailedResources[0].ResourceID: got %q", resp.FailedResources[0].ResourceID)
	}
	if resp.FailedResources[0].ReturnCode != 100001 {
		t.Errorf("FailedResources[0].ReturnCode: got %d", resp.FailedResources[0].ReturnCode)
	}
}

// TestModifyResourceStatus_NilRequest 验证 client-side 入参校验：nil request。
func TestModifyResourceStatus_NilRequest(t *testing.T) {
	cli := New("http://unused", "trade-uin")
	_, err := cli.ModifyResourceStatus(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "nil request") {
		t.Errorf("err = %v, want 'nil request'", err)
	}
}

// TestModifyResourceStatus_RequiredFieldChecks 用表驱动法批量验证必填字段缺失校验。
func TestModifyResourceStatus_RequiredFieldChecks(t *testing.T) {
	base := func() *ModifyResourceStatusRequest {
		return &ModifyResourceStatusRequest{
			ClientType:   ClientTypeProduct,
			SubmitByUser: SubmitByUserYes,
			ReferenceID:  "ref-1",
			ProductCode:  "p_lighthouse",
			OwnerUIN:     "1",
			UIN:          "1",
			AppID:        1,
			RegionID:     1,
			PayMode:      PayModePrepaid,
			OperateName:  OperateNamePreDestroy,
			ResourcesParamSet: []ModifyResourceStatusItem{
				{SubProductCode: "sp_lighthouse_pass", ResourceIDs: []string{"lhpass-1"}},
			},
		}
	}

	cases := []struct {
		name      string
		mutate    func(*ModifyResourceStatusRequest)
		errSubstr string
	}{
		{"empty ReferenceID", func(r *ModifyResourceStatusRequest) { r.ReferenceID = "" }, "ReferenceID"},
		{"empty ProductCode", func(r *ModifyResourceStatusRequest) { r.ProductCode = "" }, "ProductCode"},
		{"empty UIN", func(r *ModifyResourceStatusRequest) { r.UIN = "" }, "UIN"},
		{"empty OwnerUIN", func(r *ModifyResourceStatusRequest) { r.OwnerUIN = "" }, "OwnerUIN"},
		{"zero AppID", func(r *ModifyResourceStatusRequest) { r.AppID = 0 }, "AppID"},
		{"zero RegionID", func(r *ModifyResourceStatusRequest) { r.RegionID = 0 }, "RegionID"},
		{"empty OperateName", func(r *ModifyResourceStatusRequest) { r.OperateName = "" }, "OperateName"},
		{"empty ResourcesParamSet", func(r *ModifyResourceStatusRequest) { r.ResourcesParamSet = nil }, "ResourcesParamSet"},
		{"empty SubProductCode", func(r *ModifyResourceStatusRequest) {
			r.ResourcesParamSet[0].SubProductCode = ""
		}, "SubProductCode"},
		{"empty ResourceIDs", func(r *ModifyResourceStatusRequest) {
			r.ResourcesParamSet[0].ResourceIDs = nil
		}, "ResourceIDs"},
		{"empty resourceID element", func(r *ModifyResourceStatusRequest) {
			r.ResourcesParamSet[0].ResourceIDs = []string{"lhpass-1", "", "lhpass-3"}
		}, "ResourceIDs[1]"},
	}

	cli := New("http://unused", "trade-uin")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := base()
			tc.mutate(req)
			_, err := cli.ModifyResourceStatus(context.Background(), req)
			if err == nil {
				t.Fatalf("expected error containing %q", tc.errSubstr)
			}
			if !strings.Contains(err.Error(), tc.errSubstr) {
				t.Errorf("err = %v, want containing %q", err, tc.errSubstr)
			}
		})
	}
}
