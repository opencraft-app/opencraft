package framework

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSecretCannotBeFormattedAndReportsRedactEveryRegisteredValue(t *testing.T) {
	sanitizer := NewSanitizer()
	secret := sanitizer.Secret("sk-secret-value")
	if got := fmt.Sprintf("%s/%v/%#v", secret, secret, secret); strings.Contains(got, "sk-secret-value") {
		t.Fatalf("formatted secret leaked: %s", got)
	}

	report := Report{
		RunID: "run-secret", Scenario: "secret", Status: RunStatusFailed,
		StartedAt: time.Unix(1, 0).UTC(), FinishedAt: time.Unix(2, 0).UTC(),
		Cases: []CaseResult{{ID: "case", Status: CaseStatusFailed, Error: "upstream rejected sk-secret-value"}},
		Error: "panic: sk-secret-value",
	}
	jsonRaw, err := report.JSON(sanitizer)
	if err != nil {
		t.Fatal(err)
	}
	xmlRaw, err := report.JUnit(sanitizer)
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{"json": jsonRaw, "junit": xmlRaw} {
		if strings.Contains(string(raw), "sk-secret-value") {
			t.Fatalf("%s leaked secret: %s", name, raw)
		}
		if !strings.Contains(string(raw), RedactedValue) {
			t.Fatalf("%s did not contain redaction marker", name)
		}
	}
}

func TestJSONAndJUnitUseTheSameCaseStates(t *testing.T) {
	report := Report{
		RunID: "run-report", Scenario: "preprod", Status: RunStatusFailed,
		StartedAt: time.Unix(1, 0).UTC(), FinishedAt: time.Unix(4, 0).UTC(),
		Cases: []CaseResult{
			{ID: "pass", Status: CaseStatusPassed, Duration: time.Second},
			{ID: "fail", Status: CaseStatusFailed, Duration: 2 * time.Second, Error: "failed"},
			{ID: "skip", Status: CaseStatusSkippedDependency},
		},
	}
	jsonRaw, err := report.JSON(NewSanitizer())
	if err != nil {
		t.Fatal(err)
	}
	var decoded Report
	if err := json.Unmarshal(jsonRaw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Cases) != 3 || decoded.Cases[1].Status != CaseStatusFailed {
		t.Fatalf("decoded report = %+v", decoded)
	}
	xmlRaw, err := report.JUnit(NewSanitizer())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`tests="4"`, `failures="1"`, `skipped="2"`, `name="pass"`, `name="fail"`, `name="skip"`, `name="cleanup"`} {
		if !strings.Contains(string(xmlRaw), want) {
			t.Fatalf("JUnit missing %q: %s", want, xmlRaw)
		}
	}
}

func TestJUnitReportsCleanupFailureAsItsOwnTestcase(t *testing.T) {
	report := Report{
		Scenario: "cleanup", StartedAt: time.Unix(1, 0), FinishedAt: time.Unix(2, 0),
		Cleanup: CleanupResult{Status: CleanupStatusFailed, Actions: []CleanupActionResult{{Name: "delete tenant", Status: CleanupActionFailed, Error: "delete failed"}}},
	}
	raw, err := report.JUnit(NewSanitizer())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`tests="1"`, `failures="1"`, `name="cleanup"`, `message="delete failed"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("JUnit missing %q: %s", want, raw)
		}
	}
}

func TestSanitizerHandlesErrorAndPanicText(t *testing.T) {
	sanitizer := NewSanitizer()
	sanitizer.Secret("admin-token")
	if got := sanitizer.Error(errors.New("request admin-token failed")); got.Error() != "request [REDACTED] failed" {
		t.Fatalf("sanitized error = %q", got)
	}
	if got := sanitizer.String(fmt.Sprint("panic admin-token")); got != "panic [REDACTED]" {
		t.Fatalf("sanitized panic = %q", got)
	}
}
