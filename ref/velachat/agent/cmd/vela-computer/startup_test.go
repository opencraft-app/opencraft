package main

import (
	"errors"
	"strings"
	"testing"
)

func TestRedactedErrorHidesCredentialShapes(t *testing.T) {
	t.Parallel()
	for _, message := range []string{
		"request failed with Bearer credential_fixture",
		"request failed for https://objects.invalid/bundle?signature=fixture",
		"request failed with eyJfixture.header.signature",
		"runtime access token fixture was rejected",
	} {
		if got := redactedError(errors.New(message)); strings.Contains(got, "fixture") {
			t.Fatalf("redactedError(%q) = %q", message, got)
		}
	}
}
