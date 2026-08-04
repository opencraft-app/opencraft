package tencentim

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestUserSigCannotLeakThroughFormattingOrGenericJSON(t *testing.T) {
	const secret = "test-only-usersig-that-must-not-be-logged"
	value := UserSig{
		Value:     secret,
		ExpiresAt: time.Date(2026, 7, 30, 20, 0, 0, 0, time.UTC),
	}
	for _, formatted := range []string{
		fmt.Sprintf("%v", value),
		fmt.Sprintf("%+v", value),
		fmt.Sprintf("%#v", value),
	} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("UserSig formatting leaked value: %q", formatted)
		}
	}
	if payload, err := json.Marshal(value); err == nil {
		t.Fatalf("Marshal(UserSig) = %q, nil; want rejection", payload)
	}
}
