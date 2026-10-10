package agentcli

import (
	"testing"

	"velachat/agent/internal/common"
)

func TestFormatChannelMembersResult(t *testing.T) {
	t.Parallel()

	var result map[string]any
	if err := common.Unmarshal([]byte(`{
		"channel":{"ref":"#general","type":"channel"},
		"agents":[{
			"name":"reviewer",
			"status":"active",
			"activity":"working",
			"activityDetail":"Reviewing",
			"role":"admin",
			"description":"Reviews changes"
		}],
		"humans":[{
			"name":"alice",
			"description":"Product owner",
			"role":"owner"
		}]
	}`), &result); err != nil {
		t.Fatal(err)
	}

	got, err := formatChannelMembersResult(result)
	if err != nil {
		t.Fatal(err)
	}
	const want = "## Channel Members\n\n" +
		"Channel: #general (channel)\n" +
		"Members means join/post authority for this surface.\n\n" +
		"### Agents\n" +
		"Role labels show server-level owner/admin authority; no role label means ordinary member.\n" +
		"  - @reviewer (active; working: Reviewing) (admin) — Reviews changes\n\n" +
		"### Humans\n" +
		"Role labels show server-level owner/admin authority; no role label means ordinary member.\n" +
		"  - @alice (owner) — Product owner\n"
	if got != want {
		t.Fatalf("members output:\n%s\nwant:\n%s", got, want)
	}
}

func TestFormatChannelMembersOmitsEmptyDescriptions(t *testing.T) {
	t.Parallel()

	var result map[string]any
	if err := common.Unmarshal([]byte(`{
		"channel":{"ref":"#general","type":"channel"},
		"agents":[{"name":"reviewer","status":"active","description":""}],
		"humans":[{"name":"alice","description":""}]
	}`), &result); err != nil {
		t.Fatal(err)
	}
	got, err := formatChannelMembersResult(result)
	if err != nil {
		t.Fatal(err)
	}
	if got != "## Channel Members\n\n"+
		"Channel: #general (channel)\n"+
		"Members means join/post authority for this surface.\n\n"+
		"### Agents\n"+
		"Role labels show server-level owner/admin authority; no role label means ordinary member.\n"+
		"  - @reviewer (active)\n\n"+
		"### Humans\n"+
		"Role labels show server-level owner/admin authority; no role label means ordinary member.\n"+
		"  - @alice\n" {
		t.Fatalf("members output:\n%s", got)
	}
}
