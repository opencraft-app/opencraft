package realname

import (
	"errors"
	"testing"

	"github.com/openclaw/openclaw/mono/backend/auth/internal/service"
	tcerr "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/common/errors"
)

var testFaceIDDigestKey = []byte("0123456789abcdef0123456789abcdef")

func TestParseGetDetectInfoEnhancedTreatsMissingTextAsPending(t *testing.T) {
	t.Parallel()

	result, err := parseGetDetectInfoEnhancedResponse([]byte(`{"Response":{"RequestId":"req-missing-text"}}`), service.RealnameFaceIDGetDetectInfoExpectation{
		RuleID:       "rule-1",
		AccountID:    "acct-1",
		AttemptID:    "attempt-1",
		IdentityHash: service.HashRealnameIdentityWithKey(testFaceIDDigestKey, "张三", "11010519491231002X"),
		DigestKey:    testFaceIDDigestKey,
	})
	if err != nil || result.Completed || result.RequestID != "req-missing-text" {
		t.Fatalf("expected missing text response to remain pending, result=%+v err=%v", result, err)
	}
}

func TestParseGetDetectInfoEnhancedClassifiesInvalidBizToken(t *testing.T) {
	t.Parallel()

	_, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-invalid-token",
			"Error": {"Code": "InvalidParameter", "Message": "非法BizToken。"}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{})
	var providerErr *service.RealnameFaceIDProviderRequestError
	if !errors.As(err, &providerErr) {
		t.Fatalf("expected provider request error, got %#v", err)
	}
	if !providerErr.InvalidBizToken() || providerErr.RequestID != "req-invalid-token" {
		t.Fatalf("expected invalid BizToken classification, got %+v", providerErr)
	}
}

func TestClassifyGetDetectInfoEnhancedSDKErrorPreservesInvalidBizToken(t *testing.T) {
	t.Parallel()

	err := classifyGetDetectInfoEnhancedError(tcerr.NewTencentCloudSDKError("InvalidParameter", "非法BizToken。", "req-sdk-invalid-token"))
	var providerErr *service.RealnameFaceIDProviderRequestError
	if !errors.As(err, &providerErr) {
		t.Fatalf("expected provider request error, got %#v", err)
	}
	if !providerErr.InvalidBizToken() || providerErr.RequestID != "req-sdk-invalid-token" {
		t.Fatalf("expected invalid BizToken SDK classification, got %+v", providerErr)
	}
}

func TestParseGetDetectInfoEnhancedRejectsForeignExtraAsIntegrityFailure(t *testing.T) {
	t.Parallel()

	_, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-extra-mismatch",
			"Text": {"ErrCode": 0, "LiveStatus": 0, "Comparestatus": 0, "Extra": "foreign-attempt"}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{AttemptID: "attempt-1"})
	var integrityErr *service.RealnameFaceIDProviderIntegrityError
	if !errors.As(err, &integrityErr) || integrityErr.RequestID != "req-extra-mismatch" {
		t.Fatalf("expected foreign Extra integrity error, got %#v", err)
	}
}

func TestParseGetDetectInfoEnhancedTreatsMissingStatusFieldsAsPending(t *testing.T) {
	t.Parallel()

	result, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-missing-status",
			"Text": {
				"ErrCode": null,
				"LiveStatus": 0,
				"Comparestatus": 0,
				"Extra": "attempt-1"
			}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{AttemptID: "attempt-1"})
	if err != nil || result.Completed || result.RequestID != "req-missing-status" {
		t.Fatalf("expected nullable statuses to remain pending, result=%+v err=%v", result, err)
	}
}

func TestParseGetDetectInfoEnhancedReturnsCompletedFailureForFinalNonzeroStatus(t *testing.T) {
	t.Parallel()

	result, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-failed",
			"Text": {
				"ErrCode": 1001,
				"ErrMsg": "核身失败",
				"LiveStatus": 1001,
				"Comparestatus": 1001,
				"Extra": "attempt-1"
			}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{AttemptID: "attempt-1"})
	if err != nil || !result.Completed || result.Success {
		t.Fatalf("expected final nonzero status to be a completed failure, result=%+v err=%v", result, err)
	}
}

func TestParseGetDetectInfoEnhancedRequiresSuccessfulLivenessDetail(t *testing.T) {
	t.Parallel()

	_, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-no-live-detail",
			"Text": {
				"ErrCode": 0,
				"ErrMsg": "成功",
				"LiveStatus": 0,
				"Comparestatus": 0,
				"Name": "张三",
				"IdCard": "11010519491231002X",
				"Extra": "attempt-1",
				"LivenessDetail": []
			}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{
		RuleID:       "rule-1",
		AccountID:    "acct-1",
		AttemptID:    "attempt-1",
		IdentityHash: service.HashRealnameIdentityWithKey(testFaceIDDigestKey, "张三", "11010519491231002X"),
		DigestKey:    testFaceIDDigestKey,
	})
	if err == nil {
		t.Fatal("expected empty liveness detail to fail closed")
	}
}

func TestParseGetDetectInfoEnhancedReturnsStrictSuccess(t *testing.T) {
	t.Parallel()

	result, err := parseGetDetectInfoEnhancedResponse([]byte(`{
		"Response": {
			"RequestId": "req-success",
			"Text": {
				"ErrCode": 0,
				"ErrMsg": "成功",
				"LiveStatus": 0,
				"Comparestatus": 0,
				"Name": "张三",
				"IdCard": "11010519491231002X",
				"Extra": "attempt-1",
				"LivenessDetail": [
					{
						"Errcode": 0,
						"Livestatus": 0,
						"Comparestatus": 0,
						"Name": "张三",
						"Idcard": "11010519491231002X"
					}
				]
			}
		}
	}`), service.RealnameFaceIDGetDetectInfoExpectation{
		RuleID:       "rule-1",
		AccountID:    "acct-1",
		AttemptID:    "attempt-1",
		IdentityHash: service.HashRealnameIdentityWithKey(testFaceIDDigestKey, "张三", "11010519491231002X"),
		DigestKey:    testFaceIDDigestKey,
	})
	if err != nil {
		t.Fatalf("parse success response: %v", err)
	}
	if !result.Completed || !result.Success {
		t.Fatalf("expected strict success, got %+v", result)
	}
	if result.ProviderExtra != "attempt-1" {
		t.Fatalf("expected provider extra attempt-1, got %+v", result)
	}
}
