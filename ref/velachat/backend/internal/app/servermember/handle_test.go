package servermember

import "testing"

func TestDeriveHumanHandleProducesStableOpaqueHandle(t *testing.T) {
	accountID := "0198f4c2-7a30-7c91-a6d2-7d76f9188c37"
	memberID := "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"

	first, err := DeriveHumanHandle(accountID, memberID)
	if err != nil {
		t.Fatalf("DeriveHumanHandle() error = %v", err)
	}
	second, err := DeriveHumanHandle(accountID, memberID)
	if err != nil {
		t.Fatalf("DeriveHumanHandle() second error = %v", err)
	}
	if first != second {
		t.Fatalf("handle is not stable: %q != %q", first, second)
	}
	if first != "u_Q4JUHFNA4CTQZQIS32XH" {
		t.Fatalf("handle = %q", first)
	}
}

func TestDeriveHumanHandleRejectsNonUUIDv7(t *testing.T) {
	for _, test := range []struct {
		accountID string
		memberID  string
	}{
		{"", "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"},
		{"0198f4c2-7a30-6c91-a6d2-7d76f9188c37", "0198f4c2-7a32-7d02-b8c1-3f6e15aa91b4"},
		{"0198f4c2-7a30-7c91-a6d2-7d76f9188c37", "not-a-uuid"},
	} {
		if _, err := DeriveHumanHandle(test.accountID, test.memberID); err == nil {
			t.Fatalf(
				"DeriveHumanHandle(%q, %q) error = nil",
				test.accountID,
				test.memberID,
			)
		}
	}
}
