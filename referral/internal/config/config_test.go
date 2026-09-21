package config

import "testing"

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
