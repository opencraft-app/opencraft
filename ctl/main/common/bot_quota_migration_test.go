package common

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBotQuotaMigrationSeedsCurrentPlanTiers(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("..", "..", "migrations", "000031_add_bundle_bot_quota_per_agent.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	normalizedSQL := strings.Join(strings.Fields(string(contents)), " ")
	for _, expected := range []string{
		"ALTER TABLE `bundle` ADD COLUMN `bot_quota_per_agent` BIGINT NOT NULL DEFAULT 1 COMMENT 'maximum Hermes Profiles per Agent, including the root profile' AFTER `agent_quota`;",
		"UPDATE `bundle` SET `bot_quota_per_agent` = 5 WHERE `bundle_id` IN ('bundle_launch_01', 'bundle_launch_ai_01');",
		"UPDATE `bundle` SET `bot_quota_per_agent` = 10 WHERE `bundle_id` IN ('bundle_cruise_01', 'bundle_cruise_ai_01');",
	} {
		if !strings.Contains(normalizedSQL, expected) {
			t.Fatalf("migration missing %q", expected)
		}
	}
}
