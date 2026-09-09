package instance

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestBuildHermesProfileCreateCommandCreatesBlankProfileWithMetadata(t *testing.T) {
	command := buildHermesProfileCreateCommand("profile-2", "", "# New Bot", "New Bot", "Support")
	checks := []string{
		"hermes profile create 'profile-2'",
		"profiles/profile-2/SOUL.md",
		base64.StdEncoding.EncodeToString([]byte("# New Bot")),
		`"display_name":"New Bot"`,
		`"description":"Support"`,
	}
	for _, check := range checks {
		if !strings.Contains(command, check) {
			t.Fatalf("blank profile command missing %q: %s", check, command)
		}
	}
}

func TestBuildHermesProfileCreateCommandClonesMainAndSanitizesChannels(t *testing.T) {
	command := buildHermesProfileCreateCommand("profile-2", rootProfileID, "", "Sales", "")
	checks := []string{
		"hermes profile create 'profile-2' --clone-from 'default'",
		"config unset platforms",
		"config unset gateway.platforms",
		"category\") == \"messaging\"",
		"WEIXIN_",
		"TELEGRAM_",
		"profiles/profile-2/.env",
	}
	for _, check := range checks {
		if !strings.Contains(command, check) {
			t.Fatalf("clone command missing %q: %s", check, command)
		}
	}
	if strings.Contains(command, "profiles/main") {
		t.Fatalf("root profile must map to Hermes default: %s", command)
	}
}

func TestParseLastJSONLineIgnoresHermesProgressOutput(t *testing.T) {
	var payload hermesProfileListPayload
	err := parseLastJSONLine("loading profiles\n{\"items\":[{\"native_id\":\"default\",\"is_default\":true}]}\n", &payload)
	if err != nil {
		t.Fatalf("parse payload: %v", err)
	}
	if len(payload.Items) != 1 || payload.Items[0].NativeID != defaultHermesProfileID {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestListHermesProfilesScriptUsesOfficialProfileAPI(t *testing.T) {
	checks := []string{
		"httpx.ASGITransport(app=app)",
		`client.get(`,
		`"/api/profiles"`,
		`"X-Hermes-Session-Token": token`,
	}
	for _, check := range checks {
		if !strings.Contains(listHermesProfilesScript, check) {
			t.Fatalf("profile list script missing %q", check)
		}
	}
	if strings.Contains(listHermesProfilesScript, "from hermes_cli.profiles import list_profiles") {
		t.Fatal("profile list script must use the official GET /api/profiles route")
	}
}

func TestProjectHermesProfilesKeepsDefaultCompatibilityAndNamedProfileIdentity(t *testing.T) {
	bots := projectHermesProfiles([]hermesProfileRecord{
		{NativeID: defaultHermesProfileID, IsDefault: true},
		{NativeID: "profile-sales", DisplayName: "Sales", Description: "Pre-sales"},
	}, "ins-1", "My Hermes")
	if len(bots) != 2 {
		t.Fatalf("expected two bots, got %d", len(bots))
	}
	if bots[0].BotID != "ins-1" || bots[0].ProfileID != rootProfileID || bots[0].Name != "My Hermes" || !bots[0].IsDefault {
		t.Fatalf("unexpected default bot projection: %+v", bots[0])
	}
	if bots[1].BotID != "profile-sales" || bots[1].ProfileID != "profile-sales" || bots[1].Name != "Sales" {
		t.Fatalf("unexpected named bot projection: %+v", bots[1])
	}
}

func TestHermesNativeProfileIDMapsRootAndPreservesNamedProfiles(t *testing.T) {
	if got := hermesNativeProfileID(rootProfileID); got != defaultHermesProfileID {
		t.Fatalf("root profile mapped to %q", got)
	}
	if got := hermesNativeProfileID("profile-2"); got != "profile-2" {
		t.Fatalf("named profile changed to %q", got)
	}
}

func TestChannelBindingScriptUsesLockAndInstanceLocalHermesMetadata(t *testing.T) {
	checks := []string{
		`.lightvela`,
		`channel-bindings`,
		`fcntl.LOCK_EX`,
		`release_reserved`,
		`current.get("status") == "reserved"`,
	}
	for _, check := range checks {
		if !strings.Contains(manageChannelBindingScript, check) {
			t.Fatalf("binding script missing %q", check)
		}
	}
}

func TestChannelBindingScriptEnforcesOneOwnerAndPreservesConnectedBinding(t *testing.T) {
	home := t.TempDir()
	run := func(action, botID, profileID string) channelBindingPayload {
		t.Helper()
		command := exec.Command("python3", "-c", manageChannelBindingScript, action, botID, profileID)
		command.Env = append(os.Environ(), "HERMES_HOME="+home)
		output, err := command.Output()
		if err != nil {
			t.Fatalf("run binding action %s: %v", action, err)
		}
		var payload channelBindingPayload
		if err := json.Unmarshal(output, &payload); err != nil {
			t.Fatalf("decode binding action %s: %v", action, err)
		}
		return payload
	}

	if claim := run("claim", "bot-1", "profile-1"); !claim.OK || claim.Status != "reserved" {
		t.Fatalf("unexpected first claim: %+v", claim)
	}
	if occupied := run("claim", "bot-2", "profile-2"); occupied.OK || occupied.Reason != "occupied" || occupied.BotID != "bot-1" {
		t.Fatalf("expected occupied binding, got %+v", occupied)
	}
	if confirmed := run("confirm", "bot-1", "profile-1"); !confirmed.OK || confirmed.Status != "connected" {
		t.Fatalf("unexpected confirmation: %+v", confirmed)
	}
	run("release_reserved", "bot-1", "profile-1")
	if current := run("get", "", ""); current.BotID != "bot-1" || current.Status != "connected" {
		t.Fatalf("connected owner must survive reserved cleanup: %+v", current)
	}
	run("release", "bot-1", "profile-1")
	if current := run("get", "", ""); current.BotID != "" {
		t.Fatalf("expected released binding, got %+v", current)
	}
}

func TestShellQuoteEscapesProfileInput(t *testing.T) {
	if got := shellQuote("team's-bot"); got != "'team'\\''s-bot'" {
		t.Fatalf("unexpected shell quote: %q", got)
	}
}
