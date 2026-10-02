package main

import (
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
)

var websiteSkillCommandIDPattern = regexp.MustCompile(`^cmd-[A-Za-z0-9]+$`)

func allowedSkillTATCommandIDsByRegionFromEnv() map[string]string {
	raw := strings.TrimSpace(os.Getenv("WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION"))
	if raw == "" {
		return nil
	}
	// Reject duplicate regions/IDs, malformed/ambiguous maps, and trailing data.
	// Invalid nonempty configuration stays disabled, never using credential IDs.
	disabled := map[string]string{}
	decoder := json.NewDecoder(strings.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return disabled
	}
	ids, seen := map[string]string{}, map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		region, ok := token.(string)
		if err != nil || !ok || region == "" || region != strings.TrimSpace(region) {
			return disabled
		}
		if _, duplicate := ids[region]; duplicate {
			return disabled
		}
		var command string
		if decoder.Decode(&command) != nil {
			return disabled
		}
		command = strings.TrimSpace(command)
		if !websiteSkillCommandIDPattern.MatchString(command) || seen[command] {
			return disabled
		}
		ids[region], seen[command] = command, true
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return disabled
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return disabled
	}
	return ids
}

func websiteCommandIDInMap(command string, ids map[string]string) bool {
	if command == "" {
		return false
	}
	for _, value := range ids {
		if strings.TrimSpace(value) == command {
			return true
		}
	}
	return false
}

// Return a command kind only for the exact allocated sandbox Region. A command
// configured for both kinds (even across regions) is always denied.
func (h *handler) websiteTATCommandKind(region, command string) (skill, credential bool) {
	credentialID := strings.TrimSpace(h.allowedTATCommandID)
	if h.allowedTATCommandIDsByRegion != nil {
		credentialID = strings.TrimSpace(h.allowedTATCommandIDsByRegion[region])
	}
	skillID := strings.TrimSpace(h.allowedSkillTATCommandIDsByRegion[region])
	if websiteCommandIDInMap(command, h.allowedSkillTATCommandIDsByRegion) && (command == strings.TrimSpace(h.allowedTATCommandID) || websiteCommandIDInMap(command, h.allowedTATCommandIDsByRegion)) {
		return false, false
	}
	return skillID != "" && command == skillID, credentialID != "" && command == credentialID
}
