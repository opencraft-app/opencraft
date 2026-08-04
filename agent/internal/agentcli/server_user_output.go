package agentcli

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

type serverRuntimeContext struct {
	AgentID  string `json:"agentId"`
	ServerID string `json:"serverId"`
}

type serverInventoryView struct {
	RuntimeContext serverRuntimeContext `json:"runtimeContext"`
	Server         serverDirectoryView  `json:"server"`
	Channels       []channelView        `json:"channels"`
	Agents         []channelMember      `json:"agents"`
	Humans         []channelMember      `json:"humans"`
}

type serverDirectoryView struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

func formatVelaServerDirectory(raw map[string]any) (string, error) {
	var inventory serverInventoryView
	if err := decodeServerUserResult(raw, &inventory); err != nil {
		return "", err
	}
	if inventory.Server.ID == "" {
		inventory.Server.ID = inventory.RuntimeContext.ServerID
	}

	var text strings.Builder
	text.WriteString("## Server Directory\n\n")
	serverName := strings.TrimSpace(inventory.Server.Name)
	if serverName == "" {
		serverName = "(unavailable)"
	}
	text.WriteString("Server: " + serverName + "\n")
	if slug := strings.TrimSpace(inventory.Server.Slug); slug != "" {
		text.WriteString("Slug: " + slug + "\n")
	}
	if id := strings.TrimSpace(inventory.Server.ID); id != "" {
		text.WriteString("ID: " + id + "\n")
	}

	text.WriteString("\n### Channels\n")
	if len(inventory.Channels) == 0 {
		text.WriteString("(none)\n")
	} else {
		for _, channel := range inventory.Channels {
			joined := "not joined"
			if channel.Joined {
				joined = "joined"
			}
			fmt.Fprintf(&text, "- %s [%s, %s]%s\n",
				channelReference(channel.Name), channelVisibility(channel), joined,
				velaDirectoryIDSuffix(channel.ID))
		}
	}

	text.WriteString("\n### Agents\n")
	if len(inventory.Agents) == 0 {
		text.WriteString("(none)\n")
	} else {
		for _, agent := range inventory.Agents {
			status := ""
			if value := strings.TrimSpace(agent.Status); value != "" {
				status = " [" + value + "]"
			}
			fmt.Fprintf(&text, "- @%s%s%s%s\n", agent.Name,
				velaDirectoryDisplayName(agent), status,
				velaDirectoryMemberIDSuffix("agent", agent.AgentID, agent.MemberID))
		}
	}

	text.WriteString("\n### Humans\n")
	if len(inventory.Humans) == 0 {
		text.WriteString("(none)\n")
	} else {
		for _, human := range inventory.Humans {
			fmt.Fprintf(&text, "- @%s%s%s\n", human.Name,
				velaDirectoryDisplayName(human),
				velaDirectoryMemberIDSuffix("human", human.HumanID, human.MemberID))
		}
	}
	return text.String(), nil
}

func formatVelaUserInfo(kind string, user channelMember) string {
	lines := []string{"## User", "", "User: @" + user.Name, "Kind: " + kind}
	if value := strings.TrimSpace(user.DisplayName); value != "" {
		lines = append(lines, "Display Name: "+value)
	}
	if value := strings.TrimSpace(user.Status); value != "" {
		lines = append(lines, "Status: "+value)
	}
	if kind == "agent" {
		if value := strings.TrimSpace(user.AgentID); value != "" {
			lines = append(lines, "Agent ID: "+value)
		}
	} else if value := strings.TrimSpace(user.HumanID); value != "" {
		lines = append(lines, "Human ID: "+value)
	}
	if value := strings.TrimSpace(user.MemberID); value != "" {
		lines = append(lines, "Member ID: "+value)
	}
	return strings.Join(lines, "\n") + "\n"
}

func velaDirectoryDisplayName(member channelMember) string {
	displayName := strings.TrimSpace(member.DisplayName)
	if displayName == "" || displayName == strings.TrimSpace(member.Name) {
		return ""
	}
	return " — " + displayName
}

func velaDirectoryIDSuffix(id string) string {
	if value := strings.TrimSpace(id); value != "" {
		return " — " + value
	}
	return ""
}

func velaDirectoryMemberIDSuffix(kind string, identityID string, memberID string) string {
	parts := make([]string, 0, 2)
	if value := strings.TrimSpace(identityID); value != "" {
		parts = append(parts, kind+" "+value)
	}
	if value := strings.TrimSpace(memberID); value != "" {
		parts = append(parts, "member "+value)
	}
	if len(parts) == 0 {
		return ""
	}
	return " — " + strings.Join(parts, "; ")
}

func decodeServerUserResult(raw any, destination any) error {
	data, err := common.Marshal(raw)
	if err != nil {
		return err
	}
	return common.Unmarshal(data, destination)
}
