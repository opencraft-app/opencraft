package model

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHasConfiguredAbilityForGroupsIncludesDisabledAndNormalizedModels(t *testing.T) {
	truncateTables(t)
	require.NoError(t, DB.Create(&Ability{
		Group: "default", Model: "anthropic/claude-sonnet-4", ChannelId: 1001, Enabled: false,
	}).Error)
	require.NoError(t, DB.Create(&Ability{
		Group: "premium", Model: "gpt-4o-gizmo-*", ChannelId: 1002, Enabled: true,
	}).Error)

	tests := []struct {
		name   string
		groups []string
		model  string
		want   bool
	}{
		{"disabled channel still configured", []string{"default"}, "anthropic/claude-sonnet-4", true},
		{"other group is not configured", []string{"premium"}, "anthropic/claude-sonnet-4", false},
		{"unknown model", []string{"default"}, "unknown-model", false},
		{"auto group includes matching group", []string{"default", "premium"}, "anthropic/claude-sonnet-4", true},
		{"normalized model", []string{"premium"}, "gpt-4o-gizmo-test", true},
		{"no eligible groups", nil, "anthropic/claude-sonnet-4", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := HasConfiguredAbilityForGroups(tt.groups, tt.model)
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}
