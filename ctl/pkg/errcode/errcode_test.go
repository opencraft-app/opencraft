package errcode

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrorInterface(t *testing.T) {
	err := ErrInstanceNotFound
	if err.Error() != "instance not found" {
		t.Errorf("expected 'instance not found', got '%s'", err.Error())
	}
}

func TestErrorIs(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", ErrQuotaExceeded)
	if !errors.Is(wrapped, ErrQuotaExceeded) {
		t.Error("errors.Is should match wrapped ErrQuotaExceeded")
	}
}

func TestErrorAs(t *testing.T) {
	wrapped := fmt.Errorf("context: %w", ErrInstanceNotFound)
	var bizErr *Error
	if !errors.As(wrapped, &bizErr) {
		t.Error("errors.As should extract *Error from wrapped error")
	}
	if bizErr.Code != "INSTANCE_NOT_FOUND" {
		t.Errorf("expected code INSTANCE_NOT_FOUND, got %s", bizErr.Code)
	}
	if bizErr.HTTPStatus != 404 {
		t.Errorf("expected HTTP status 404, got %d", bizErr.HTTPStatus)
	}
}

func TestNew(t *testing.T) {
	err := New("TEST_ERROR", 500, "test error message")
	if err.Code != "TEST_ERROR" {
		t.Errorf("expected code TEST_ERROR, got %s", err.Code)
	}
	if err.HTTPStatus != 500 {
		t.Errorf("expected HTTP status 500, got %d", err.HTTPStatus)
	}
}

func TestRegisteredErrorsAreUnique(t *testing.T) {
	seen := map[string]struct{}{}
	for _, err := range RegisteredErrors() {
		if err == nil {
			t.Fatal("registered nil error")
		}
		if err.Code == "" {
			t.Fatal("registered empty code")
		}
		if _, ok := seen[err.Code]; ok {
			t.Fatalf("duplicate registered code: %s", err.Code)
		}
		seen[err.Code] = struct{}{}
	}
	if len(seen) == 0 {
		t.Fatal("expected registered errors")
	}
}
