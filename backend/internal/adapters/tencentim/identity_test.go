package tencentim

import (
	"regexp"
	"testing"
)

func TestHumanIdentityDeriverProducesStableOpaqueTencentUserID(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	deriver, err := NewIdentityDeriver(key)
	if err != nil {
		t.Fatalf("NewIdentityDeriver() error = %v", err)
	}

	first, err := deriver.HumanUserID("01989c24-7540-7f12-a27b-c83243215dd1")
	if err != nil {
		t.Fatalf("HumanUserID() error = %v", err)
	}
	second, err := deriver.HumanUserID("01989c24-7540-7f12-a27b-c83243215dd1")
	if err != nil {
		t.Fatalf("HumanUserID() second error = %v", err)
	}
	if first != second {
		t.Fatalf("HumanUserID() is not stable: %q != %q", first, second)
	}
	if first != "u_BKHSUO5LLVUPHQTHDIA5U46EWD5ZQ" {
		t.Fatalf("HumanUserID() = %q", first)
	}
	if len(first) != 31 {
		t.Fatalf("HumanUserID() length = %d, want 31", len(first))
	}
	if !regexp.MustCompile(`^u_[A-Z2-7]{29}$`).MatchString(first) {
		t.Fatalf("HumanUserID() = %q, contains unsupported characters", first)
	}
}

func TestHumanIdentityDeriverRejectsUnsafeConfigurationAndAccountID(t *testing.T) {
	if _, err := NewIdentityDeriver([]byte("short")); err == nil {
		t.Fatal("NewIdentityDeriver(short key) error = nil")
	}
	deriver, err := NewIdentityDeriver(
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, accountID := range []string{"", "not-a-uuid", "01989c24-7540-6f12-a27b-c83243215dd1"} {
		if _, err := deriver.HumanUserID(accountID); err == nil {
			t.Fatalf("HumanUserID(%q) error = nil", accountID)
		}
	}
}

func TestAgentIdentityDeriverProducesStableDomainSeparatedUserID(t *testing.T) {
	deriver, err := NewIdentityDeriver(
		[]byte("0123456789abcdef0123456789abcdef"),
	)
	if err != nil {
		t.Fatal(err)
	}
	const agentID = "01989c24-7540-7f12-a27b-c83243215dd4"
	first, err := deriver.AgentUserID(agentID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := deriver.AgentUserID(agentID)
	if err != nil {
		t.Fatal(err)
	}
	human, err := deriver.HumanUserID(agentID)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first == human ||
		!regexp.MustCompile(`^a_[A-Z2-7]{29}$`).MatchString(first) {
		t.Fatalf(
			"AgentUserID() = (%q, %q), human=%q",
			first,
			second,
			human,
		)
	}
}
