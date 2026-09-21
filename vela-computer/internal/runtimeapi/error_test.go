package runtimeapi

import "testing"

func TestRuntimeErrorFingerprintMatchesObservedNormalization(t *testing.T) {
	t.Parallel()

	first := "Provider request 123 failed for deadbeefcafebabe"
	second := " provider   request 987 failed for 0123456789abcdef "
	if got := FingerprintRuntimeError(first); got != "fc722ca715f3e15a" {
		t.Fatalf("FingerprintRuntimeError(first) = %q", got)
	}
	if got := FingerprintRuntimeError(second); got != "fc722ca715f3e15a" {
		t.Fatalf("FingerprintRuntimeError(second) = %q", got)
	}
}

func TestRuntimeErrorFingerprintFenceEligibility(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"not logged in; please log in",
		"codex_zero_evidence_turn_completed",
		"selected model is not supported",
		"unsupported model fixture",
	} {
		if RuntimeErrorFingerprintFenceEligible(message) {
			t.Fatalf("terminal error %q unexpectedly contributes to fence", message)
		}
	}
	if !RuntimeErrorFingerprintFenceEligible("provider failed request 42") {
		t.Fatal("ordinary provider error does not contribute to fence")
	}
}

func TestRuntimeErrorStickyTerminalClassification(t *testing.T) {
	t.Parallel()

	for _, message := range []string{
		"Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)",
		"selected model is not supported",
		"unsupported model fixture",
	} {
		if !RuntimeErrorIsStickyTerminal(message) {
			t.Fatalf("sticky terminal error %q was not classified", message)
		}
	}
	for _, message := range []string{
		"provider failed request 42",
		"HTTP 429 Too Many Requests",
		"not logged in; please log in",
	} {
		if RuntimeErrorIsStickyTerminal(message) {
			t.Fatalf("recoverable/action-required error %q became sticky", message)
		}
	}
}

func TestRuntimeErrorActivityDiagnosticClassifiesObservedFamilies(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		message    string
		errorClass string
		reason     string
	}{
		{"Provider request 123 failed for deadbeefcafebabe", "RuntimeError", "unclassified_runtime_error"},
		{"HTTP 429 Too Many Requests", "RateLimitError", "rate_limited"},
		{"status code 401 Unauthorized", "AuthError", "auth_failed"},
		{"HTTP 404 Not Found", "NotFoundError", "not_found"},
		{"HTTP 503 Service Unavailable", "ProviderServerError", "provider_server_error"},
		{"HTTP 400 Bad Request", "ProviderApiError", "provider_api_error"},
		{"model gpt-fixture is not supported", "ModelConfigError", "model_config_error"},
		{"request timed out", "TimeoutError", "provider_timeout"},
		{"upstream ECONNRESET", "ProviderConnectionError", "provider_connection_error"},
		{"stream closed before response.completed", "ProviderStreamError", "provider_stream_error"},
		{"input too large for model", "InputTooLargeError", "input_too_large"},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.errorClass, func(t *testing.T) {
			t.Parallel()
			got := RuntimeErrorActivityDiagnostic(testCase.message)
			if got.ErrorClass != testCase.errorClass ||
				got.ErrorReason != testCase.reason ||
				got.ReasonProvenance != "runtime_error_event" ||
				got.Fingerprint != FingerprintRuntimeError(testCase.message) {
				t.Fatalf("RuntimeErrorActivityDiagnostic(%q) = %#v", testCase.message, got)
			}
		})
	}
}

func TestRuntimeErrorActivityDiagnosticNormalizesUnknownExplicitClass(t *testing.T) {
	t.Parallel()

	got := RuntimeErrorActivityDiagnostic("FixtureProviderException: failed")
	if got.ErrorClass != "RuntimeError" ||
		got.ErrorReason != "unclassified_runtime_error" {
		t.Fatalf("unknown explicit class diagnostic = %#v", got)
	}
}
