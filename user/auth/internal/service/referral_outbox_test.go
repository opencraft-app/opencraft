package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestReferralClaimEnvelopeIsStableAndDistinctFromRegistration(t *testing.T) {
	now := time.Date(2026, 9, 17, 8, 20, 0, 0, time.UTC)
	first := newReferralClaimEnvelope("usr_invitee", " hbygspxsad ", "oauth:wechat", now)
	second := newReferralClaimEnvelope("usr_invitee", "HBYGSPXSAD", "oauth:wechat", now.Add(time.Minute))

	if first.EventType != "user.referral_claimed.v1" || first.EventID != second.EventID {
		t.Fatalf("claim envelope is not stable: first=%+v second=%+v", first, second)
	}
	if !strings.HasPrefix(first.EventID, "user.referral_claimed:usr_invitee:") {
		t.Fatalf("unexpected claim event id %q", first.EventID)
	}
	if first.Payload.ReferralCode != "HBYGSPXSAD" || first.Payload.ClaimChannel != "oauth:wechat" {
		t.Fatalf("unexpected claim payload %+v", first.Payload)
	}
	payload, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "registration_channel") {
		t.Fatalf("claim must not masquerade as registration: %s", payload)
	}
}
