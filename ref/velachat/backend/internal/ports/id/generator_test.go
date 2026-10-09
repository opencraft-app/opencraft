package id

import (
	"testing"

	"github.com/google/uuid"
)

type fixedGenerator struct {
	value string
}

func (g fixedGenerator) New() (string, error) {
	return g.value, nil
}

func TestGeneratorCanBeReplacedByDeterministicFake(t *testing.T) {
	const want = "01989c24-7540-7f12-a27b-c83243215dd1"
	var subject Generator = fixedGenerator{value: want}

	got, err := subject.New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if got != want {
		t.Fatalf("New() = %q, want %q", got, want)
	}
}

func TestUUIDv7GeneratorUsesSharedIDGenerator(t *testing.T) {
	var subject Generator = UUIDv7{}
	got, err := subject.New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	parsed, err := uuid.Parse(got)
	if err != nil {
		t.Fatalf("New() = %q, want UUID: %v", got, err)
	}
	if parsed.Version() != 7 {
		t.Fatalf("New() version = %d, want 7", parsed.Version())
	}
}
