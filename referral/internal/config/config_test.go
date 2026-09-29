package config

import (
	"strings"
	"testing"
)

func TestLoadDefaultsBothReferralRewardsToFiveHundredCredits(t *testing.T) {
	t.Setenv("REFERRAL_ENABLED", "false")
	t.Setenv("REFERRAL_INVITER_CREDIT", "")
	t.Setenv("REFERRAL_INVITEE_CREDIT", "")
	t.Setenv("REFERRAL_VESTING_DAYS", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Campaign.InviterCredit != 500 || cfg.Campaign.InviteeCredit != 500 {
		t.Fatalf("unexpected referral reward defaults: inviter=%d invitee=%d",
			cfg.Campaign.InviterCredit, cfg.Campaign.InviteeCredit)
	}
	if cfg.Campaign.VestingDays != 0 {
		t.Fatalf("default campaign must not delay rewards: %d", cfg.Campaign.VestingDays)
	}
}

func TestEnabledReferralRequiresCTLForAttributionReset(t *testing.T) {
	t.Setenv("REFERRAL_ENABLED", "true")
	t.Setenv("REFERRAL_MYSQL_DSN", "referral:secret@tcp(mysql:3306)/referral")
	t.Setenv("CTL_INTERNAL_BASE_URL", "")
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "")
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "required when referral is enabled") {
		t.Fatalf("expected missing CTL dependency error, got %v", err)
	}

	t.Setenv("CTL_INTERNAL_BASE_URL", "http://ctl-api.ctl.svc.cluster.local")
	t.Setenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "internal-token")
	if _, err := Load(); err != nil {
		t.Fatalf("complete enabled config rejected: %v", err)
	}
}
