package agentmanagement

import (
	"time"

	agentport "chatserver/internal/ports/agent"
)

const defaultHostLeaseTTL = 20 * time.Minute

// projectAvailability 只组合已持久化事实，不创造第三套在线协议。
func projectAvailability(
	value agentport.Agent,
	now time.Time,
	hostLeaseTTL time.Duration,
) string {
	if value.DesiredState != "running" {
		return "offline"
	}
	if value.CurrentLaunchID == nil || value.CurrentLaunchAssignmentEpoch == nil ||
		value.CurrentLaunchGeneration != value.Revision ||
		value.CurrentLaunchCredentialVersion != value.CredentialVersion {
		return "offline"
	}
	if value.ObservedAssignmentEpoch == nil ||
		*value.ObservedAssignmentEpoch != *value.CurrentLaunchAssignmentEpoch ||
		value.ObservedGeneration != value.CurrentLaunchGeneration ||
		value.ObservedAttempt != value.CurrentLaunchAttempt ||
		value.ObservedLaunchID == nil || *value.ObservedLaunchID != *value.CurrentLaunchID {
		return "unknown"
	}
	if value.ObservedState == "stopped" || value.ObservedState == "error" {
		return "offline"
	}
	if value.IMTransportState == "disconnected" || value.IMTransportState == "error" {
		return "offline"
	}
	if value.HostLastSeenAt != nil &&
		now.Sub(value.HostLastSeenAt.UTC()) > hostLeaseTTL {
		return "offline"
	}
	if value.ObservedState == "running" && value.IMTransportState == "connected" &&
		value.HostLastSeenAt != nil {
		return "online"
	}
	return "unknown"
}

func (service *Service) projectAgentAvailability(
	value agentport.Agent,
) agentport.Agent {
	if value.IMPresence == "" {
		value.IMPresence = "unknown"
	}
	if value.IMTransportState == "" {
		value.IMTransportState = "unknown"
	}
	value.Availability = projectAvailability(
		value,
		service.clock.Now().UTC(),
		defaultHostLeaseTTL,
	)
	return value
}
