package agentcli

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

type channelView struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	Description   *string `json:"description"`
	Joined        bool    `json:"joined"`
	Muted         *bool   `json:"muted"`
	ActivityMuted *bool   `json:"activityMuted"`
	Archived      *bool   `json:"archived"`
}

type channelServerInfo struct {
	Channels []channelView `json:"channels"`
}

type channelMember struct {
	Name           string  `json:"name"`
	DisplayName    string  `json:"displayName"`
	Status         string  `json:"status"`
	Activity       *string `json:"activity"`
	ActivityDetail *string `json:"activityDetail"`
	Role           *string `json:"role"`
	Description    *string `json:"description"`
	MemberID       string  `json:"memberId"`
	AgentID        string  `json:"agentId"`
	HumanID        string  `json:"humanId"`
}

type channelMembersView struct {
	Channel struct {
		Ref  string `json:"ref"`
		Type string `json:"type"`
	} `json:"channel"`
	Agents []channelMember `json:"agents"`
	Humans []channelMember `json:"humans"`
}

type channelMemberCounts struct {
	Agents int
	Humans int
}

func formatChannelMembersResult(result map[string]any) (string, error) {
	var members channelMembersView
	if err := decodeChannelResult(result, &members); err != nil {
		return "", err
	}
	var text strings.Builder
	text.WriteString("## Channel Members\n\n")
	ref := members.Channel.Ref
	if ref == "" {
		ref = "(unknown)"
	}
	channelType := ""
	if members.Channel.Type != "" {
		channelType = " (" + members.Channel.Type + ")"
	}
	fmt.Fprintf(&text, "Channel: %s%s\n", ref, channelType)
	text.WriteString("Members means join/post authority for this surface.\n\n")
	text.WriteString("### Agents\n")
	text.WriteString("Role labels show server-level owner/admin authority; no role label means ordinary member.\n")
	if len(members.Agents) == 0 {
		text.WriteString("  (none)\n")
	} else {
		for _, agent := range members.Agents {
			fmt.Fprintf(&text, "  - @%s (%s)%s%s\n", agent.Name,
				channelAgentStatus(agent), channelRoleLabel(agent.Role),
				channelDescriptionSuffix(agent.Description))
		}
	}
	text.WriteString("\n### Humans\n")
	text.WriteString("Role labels show server-level owner/admin authority; no role label means ordinary member.\n")
	if len(members.Humans) == 0 {
		text.WriteString("  (none)\n")
	} else {
		for _, human := range members.Humans {
			fmt.Fprintf(&text, "  - @%s%s%s\n", human.Name,
				channelRoleLabel(human.Role), channelDescriptionSuffix(human.Description))
		}
	}
	return text.String(), nil
}

func formatChannelInfo(channel channelView, memberCounts *channelMemberCounts) string {
	lines := []string{"## Channel", "", "Channel: " + channelReference(channel.Name)}
	if channel.ID != "" {
		lines = append(lines, "ID: "+channel.ID)
	}
	lines = append(lines, "Visibility: "+channelVisibility(channel), "Joined: "+yesNo(channel.Joined))
	if muted := channelMuted(channel); muted != nil {
		lines = append(lines, "Muted: "+yesNo(*muted))
	}
	if channel.Archived != nil {
		lines = append(lines, "Archived: "+yesNo(*channel.Archived))
	}
	description := "(none)"
	if channel.Description != nil && strings.TrimSpace(*channel.Description) != "" {
		description = strings.TrimSpace(*channel.Description)
	}
	lines = append(lines, "Description: "+description)
	if memberCounts != nil {
		lines = append(lines, fmt.Sprintf("Members: %d (%d agents, %d humans)",
			memberCounts.Agents+memberCounts.Humans, memberCounts.Agents, memberCounts.Humans))
	}
	lines = append(lines, "", fmt.Sprintf("More: raft channel members %q", channelReference(channel.Name)))
	return strings.Join(lines, "\n") + "\n"
}

func decodeChannelResult(result map[string]any, destination any) error {
	data, err := common.Marshal(result)
	if err != nil {
		return err
	}
	return common.Unmarshal(data, destination)
}

func channelReference(name string) string {
	if strings.HasPrefix(name, "#") {
		return name
	}
	return "#" + name
}

func channelVisibility(channel channelView) string {
	if strings.TrimSpace(channel.Type) == "private" {
		return "private"
	}
	return "public"
}

func channelMuted(channel channelView) *bool {
	if channel.Muted != nil {
		return channel.Muted
	}
	return channel.ActivityMuted
}

func channelAgentStatus(agent channelMember) string {
	lifecycle := strings.TrimSpace(agent.Status)
	if lifecycle == "" {
		lifecycle = "unknown"
	}
	activity := strings.TrimSpace(optionalString(agent.Activity, ""))
	if activity == "" || activity == lifecycle {
		return lifecycle
	}
	detail := strings.TrimSpace(optionalString(agent.ActivityDetail, ""))
	if detail != "" {
		activity += ": " + detail
	}
	return lifecycle + "; " + activity
}

func channelRoleLabel(role *string) string {
	value := strings.TrimSpace(optionalString(role, ""))
	if value == "" || value == "member" {
		return ""
	}
	return " (" + value + ")"
}

func channelDescriptionSuffix(description *string) string {
	if description == nil || *description == "" {
		return ""
	}
	return " — " + *description
}

func optionalString(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}
