package pass

import (
	"errors"
	"testing"

	"ctl/pkg/errcode"
)

func TestCreateTrialPassBundleRestriction(t *testing.T) {
	l := &logic{}
	cases := []struct {
		name     string
		userID   string
		bundleID string
		wantErr  error
	}{
		{name: "empty_bundle_id", userID: "user_123", bundleID: "", wantErr: errcode.ErrPassInvalidParam},
		{name: "paid_bundle_id", userID: "user_123", bundleID: "bundle_launch_01", wantErr: errcode.ErrPassTrialBundleNotAllowed},
		{name: "other_free_trial_bundle_id", userID: "user_123", bundleID: "bundle_free_trial_02", wantErr: errcode.ErrPassTrialBundleNotAllowed},
		{name: "prefix_only_not_allowed", userID: "user_123", bundleID: "bundle_free_trial", wantErr: errcode.ErrPassTrialBundleNotAllowed},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			result, err := l.CreateTrialPass(c.userID, c.bundleID)
			if err == nil {
				t.Fatalf("CreateTrialPass(%q, %q) expected non-nil err", c.userID, c.bundleID)
			}
			if result != nil {
				t.Fatalf("CreateTrialPass(%q, %q) result = %+v, want nil", c.userID, c.bundleID, result)
			}
			if !errors.Is(err, c.wantErr) {
				t.Fatalf("CreateTrialPass(%q, %q) = %v, want errors.Is %v", c.userID, c.bundleID, err, c.wantErr)
			}
		})
	}
}
