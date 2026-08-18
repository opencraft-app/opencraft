package pass

import (
	"testing"

	passmodel "ctl/pkg/model/pass"
)

func TestNormalizeCompletePassRenewFlag(t *testing.T) {
	tests := []struct {
		name string
		flag string
		want string
	}{
		{name: "auto_renew", flag: passmodel.RenewFlagAuto, want: passmodel.RenewFlagAuto},
		{name: "manual_renew", flag: passmodel.RenewFlagManual, want: passmodel.RenewFlagManual},
		{name: "missing", want: passmodel.RenewFlagManual},
		{name: "unknown", flag: "INVALID", want: passmodel.RenewFlagManual},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCompletePassRenewFlag(tt.flag); got != tt.want {
				t.Fatalf("normalizeCompletePassRenewFlag(%q) = %q, want %q", tt.flag, got, tt.want)
			}
		})
	}
}
