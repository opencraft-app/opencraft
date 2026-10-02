package instance

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	modelinstance "ctl/pkg/model/instance"
	"go.uber.org/zap"
)

// Skill-only delivery is optional, bounded, and never issues/rotates credentials.
const websiteSkillDeliveryTimeout = 30

var websiteSkillCommandIDPattern = regexp.MustCompile(`^cmd-[A-Za-z0-9]+$`)

func websiteSkillTATCommandIDsByRegionFromEnv() map[string]string {
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

func (l *logic) websiteCommandIDOverlapsSkill(command string) bool {
	return websiteCommandIDInMap(command, l.websiteSkillTATCommandIDsByRegion)
}

func (l *logic) deliverWebsiteSkillOnCreate(ctx pctx.Context, entity *modelinstance.Entity, sandboxID string) {
	if len(l.websiteSkillTATCommandIDsByRegion) == 0 {
		return
	}
	if entity == nil || strings.TrimSpace(entity.InstanceId) == "" || strings.TrimSpace(entity.UserId) == "" || strings.TrimSpace(sandboxID) == "" {
		return
	}
	invoker, ok := l.sandboxAdapter.(psandbox.CommandInvoker)
	if !ok {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, websiteSkillDeliveryTimeout*time.Second)
	defer cancel()
	detail, err := l.sandboxAdapter.GetSandbox(bounded, sandboxID)
	if err != nil || detail == nil || strings.TrimSpace(detail.Region) == "" {
		l.logger.Warn("skip website skill delivery because sandbox region is unavailable", zap.String("sandbox_id", sandboxID))
		return
	}
	region := strings.TrimSpace(detail.Region)
	commandID := strings.TrimSpace(l.websiteSkillTATCommandIDsByRegion[region])
	if !websiteSkillCommandIDPattern.MatchString(commandID) || commandID == strings.TrimSpace(l.websiteCredentialTATCommandID) || websiteCommandIDInMap(commandID, l.websiteCredentialTATCommandIDsByRegion) {
		l.logger.Warn("skip website skill delivery because region command is missing invalid or overlaps credential", zap.String("region", region), zap.String("sandbox_id", sandboxID))
		return
	}
	result, err := invoker.InvokeCommand(bounded, sandboxID, commandID, nil, websiteSkillDeliveryTimeout)
	if err != nil || result == nil || strings.ToUpper(strings.TrimSpace(result.Status)) != "SUCCESS" || result.ExitCode != 0 {
		// No output/ErrorInfo/error text: the command may encounter user-custom files.
		// No retries, root fallback, account creation, or exception repair.
		l.logger.Warn("website skill command during instance create did not succeed", zap.String("instance_id", entity.InstanceId), zap.String("sandbox_id", sandboxID), zap.String("region", region), zap.String("command_id", commandID))
		return
	}
	// Metadata SUCCESS does not prove UPDATED: an auth-only script may safely skip
	// missing/custom/managed Skills. Acceptance belongs to the rollout operator.
	l.logger.Info("website skill command completed during instance create", zap.String("instance_id", entity.InstanceId), zap.String("sandbox_id", sandboxID), zap.String("region", region), zap.String("command_id", commandID))
}
