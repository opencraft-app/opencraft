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
	sql := string(contents)
	for _, expected := range []string{
		"ADD COLUMN `bot_quota_per_agent` BIGINT NOT NULL DEFAULT 1",
		"SET `bot_quota_per_agent` = 5",
		"'bundle_launch_01', 'bundle_launch_ai_01'",
		"SET `bot_quota_per_agent` = 10",
		"'bundle_cruise_01', 'bundle_cruise_ai_01'",
	} {
		if !strings.Contains(sql, expected) {
			t.Fatalf("migration missing %q", expected)
		}
	}
}
