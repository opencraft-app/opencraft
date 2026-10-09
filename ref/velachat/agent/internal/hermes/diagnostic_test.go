package hermes

import (
	"strings"
	"testing"
)

func TestCaptureHermesStderrDisabledDiscardsInput(t *testing.T) {
	t.Parallel()

	got := captureHermesStderr(
		strings.NewReader("Bearer must-not-be-retained\n"),
		false,
	)
	if got != "" {
		t.Fatalf("disabled stderr capture = %q", got)
	}
}

func TestCaptureHermesStderrIsBoundedAndRedacted(t *testing.T) {
	t.Parallel()

	input := strings.Repeat("x", 100_000) + "\n" +
		"Authorization: Bearer secret-bearer\n" +
		"api_key=sk-example-secret\n" +
		"proxy=https://alice:password@example.test/path\n" +
		"token=sap_example_capability\n" +
		"jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature\n"
	got := captureHermesStderr(strings.NewReader(input), true)
	if len(got) > maximumStderrTail {
		t.Fatalf("stderr tail length = %d", len(got))
	}
	for _, secret := range []string{
		"secret-bearer",
		"sk-example-secret",
		"alice:password",
		"sap_example_capability",
		"eyJhbGciOiJIUzI1NiJ9",
	} {
		if strings.Contains(got, secret) {
			t.Fatalf("stderr tail retained secret %q: %q", secret, got)
		}
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("stderr tail did not mark redactions: %q", got)
	}
}
