package agentmanagement

import (
	"testing"
	"time"

	agentport "chatserver/internal/ports/agent"
)

func TestProjectAvailabilityUsesCurrentLaunchRuntimeTransportAndHostLease(t *testing.T) {
	now := time.Date(2026, 7, 31, 18, 0, 0, 0, time.UTC)
	recent := now.Add(-time.Minute)
	stale := now.Add(-21 * time.Minute)
	tests := []struct {
		name  string
		agent agentport.Agent
		want  string
	}{
		{
			name:  "online",
			agent: currentObservedAgent("running", "connected", "offline", &recent),
			want:  "online",
		},
		{
			name:  "transport disconnected",
			agent: currentObservedAgent("running", "disconnected", "online", &recent),
			want:  "offline",
		},
		{
			name:  "stale host lease",
			agent: currentObservedAgent("running", "connected", "online", &stale),
			want:  "offline",
		},
		{
			name:  "stopped lifecycle",
			agent: currentObservedAgent("stopped", "connected", "online", &recent),
			want:  "offline",
		},
		{
			name:  "transport connecting",
			agent: currentObservedAgent("running", "connecting", "online", &recent),
			want:  "unknown",
		},
		{
			name:  "host not observed",
			agent: currentObservedAgent("running", "connected", "online", nil),
			want:  "unknown",
		},
		{
			name: "observed fence differs from current launch",
			agent: func() agentport.Agent {
				value := currentObservedAgent("running", "connected", "online", &recent)
				value.ObservedAttempt--
				return value
			}(),
			want: "unknown",
		},
		{
			name: "current launch no longer matches config",
			agent: func() agentport.Agent {
				value := currentObservedAgent("running", "connected", "online", &recent)
				value.Revision++
				return value
			}(),
			want: "offline",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := projectAvailability(
				test.agent,
				now,
				20*time.Minute,
			); got != test.want {
				t.Fatalf("projectAvailability() = %q，期望 %q", got, test.want)
			}
		})
	}
}

func currentObservedAgent(
	state string,
	transport string,
	presence string,
	hostSeenAt *time.Time,
) agentport.Agent {
	epoch := "01989c24-7540-7f12-a27b-c83243215dd7"
	launchID := "01989c24-7540-7f12-a27b-c83243215dda"
	return agentport.Agent{
		DesiredState: "running", ObservedState: state,
		IMPresence: presence, IMTransportState: transport,
		HostLastSeenAt: hostSeenAt, Revision: 6, CredentialVersion: 2,
		CurrentLaunchID: &launchID, CurrentLaunchAssignmentEpoch: &epoch,
		CurrentLaunchGeneration: 6, CurrentLaunchCredentialVersion: 2,
		CurrentLaunchAttempt:    3,
		ObservedAssignmentEpoch: &epoch, ObservedGeneration: 6,
		ObservedAttempt: 3, ObservedLaunchID: &launchID,
	}
}
