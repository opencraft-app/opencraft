package runtimeactor

import "testing"

func TestLocalOnlyLaunchIdentity(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		value string
		want  bool
	}{
		{value: "local_legacy_aaaaaaaa", want: true},
		{value: "local_legacy_", want: true},
		{value: "019fc179-4b0f-75a4-bc6d-b8348a7ab68e", want: false},
		{value: "", want: false},
	} {
		if got := isLocalOnlyLaunchID(test.value); got != test.want {
			t.Fatalf("isLocalOnlyLaunchID(%q) = %t, want %t", test.value, got, test.want)
		}
	}
}
