package instance

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	psandbox "ctl/pkg/adapter/sandbox"
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	modelinstance "ctl/pkg/model/instance"

	"go.uber.org/zap"
)

func TestBuildHermesProfileCreateCommandCreatesBlankProfileWithMetadata(t *testing.T) {
	command := buildHermesProfileCreateCommand("profile-2", "", "# New Bot", "New Bot", "Support")
	checks := []string{
		"hermes profile create 'profile-2'",
		"base-skills",
		"Aligned",
		`source_home = Path(sys.argv[1])`,
		`target_config.pop("fallback_providers", None)`,
		`target_config["providers"] = {provider_key: selected_provider}`,
		`source_env = dotenv_values(source_home / ".env", interpolate=False)`,
		`Other profile credentials are intentionally not inherited.`,
		`"$hermes_home/profiles/profile-2"`,
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
	if strings.Contains(command, "--no-skills") || strings.Contains(command, "--clone-from") {
		t.Fatalf("blank profile must seed its own curated skills without cloning: %s", command)
	}
	if strings.Contains(command, `cp "$hermes_home/.env"`) {
		t.Fatalf("blank profile must not copy the complete root env: %s", command)
	}
}

func TestBuildHermesProfileCreateCommandFitsTATLimit(t *testing.T) {
	command := buildHermesProfileCreateCommand(
		"profile-max",
		"",
		strings.Repeat("界", maxInstanceBotSoulRunes),
		strings.Repeat("名", maxInstanceBotNameRunes),
		strings.Repeat("述", maxInstanceBotDescriptionRunes),
	)
	if got, limit := len([]byte(command)), 64*1024; got >= limit {
		t.Fatalf("maximal Hermes profile create command is %d bytes, must stay below TAT limit %d", got, limit)
	}
}

func TestCopyHermesPrimaryModelScriptScopesProviderAndCredentials(t *testing.T) {
	checks := []string{
		`model_keys = (`,
		`"default", "model", "name", "provider", "base_url", "api_mode", "transport"`,
		`"key_env", "api_key_env"`,
		`target_config.pop("fallback_model", None)`,
		`target_config.pop("fallback_providers", None)`,
		`target_config.pop("providers", None)`,
		`target_config.pop("custom_providers", None)`,
		`target_config["custom_providers"] = [selected_legacy_provider]`,
		`provider_config.get("key_env")`,
		`for name in credential_env:`,
		`for name in dependency_env:`,
		`break`,
	}
	for _, check := range checks {
		if !strings.Contains(copyHermesPrimaryModelScript, check) {
			t.Fatalf("primary model snapshot script missing %q", check)
		}
	}
	for _, excluded := range []string{`copy2(source_home / ".env"`, `source_config.get("fallback_providers")`} {
		if strings.Contains(copyHermesPrimaryModelScript, excluded) {
			t.Fatalf("primary model snapshot script must not include %q", excluded)
		}
	}
}

func TestBuildHermesProfileCreateCommandClonesMainAndSanitizesChannels(t *testing.T) {
	command := buildHermesProfileCreateCommand("profile-2", rootProfileID, "", "Sales", "")
	checks := []string{
		"hermes profile create 'profile-2' --clone-from 'default'",
		"config unset 'platforms'",
		"Config key not set: platforms",
		"config unset 'gateway.platforms'",
		"Config key not set: gateway.platforms",
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
	if strings.Contains(command, "--no-skills") {
		t.Fatalf("clone creation must preserve the source profile skills: %s", command)
	}
	if strings.Contains(command, "base-skills") {
		t.Fatalf("clone creation must preserve the source profile skills without alignment: %s", command)
	}
	if strings.Contains(command, "copyHermesPrimaryModelScript") || strings.Contains(command, `source_home = Path(sys.argv[1])`) {
		t.Fatalf("explicit clone must not be replaced by the blank-profile model snapshot: %s", command)
	}
}

func TestAlignBlankProfileSkillsUsesRecordedBaseline(t *testing.T) {
	home := t.TempDir()
	target := home + "/profiles/profile-2"
	writeSkillFixture(t, home+"/skills/software-development/base-skill", "root base")
	writeSkillFixture(t, home+"/skills/software-development/later-installed", "root user")
	writeSkillFixture(t, target+"/skills/software-development/base-skill", "seeded base")
	writeSkillFixture(t, target+"/skills/software-development/root-missing-base", "seeded root-missing base")
	writeSkillFixture(t, target+"/skills/software-development/full-catalog", "seeded extra")
	if err := os.MkdirAll(home+"/.lightvela", 0o755); err != nil {
		t.Fatalf("create baseline directory: %v", err)
	}
	if err := os.WriteFile(home+"/.lightvela/base-skills", []byte("software-development/base-skill\nsoftware-development/root-missing-base\n"), 0o600); err != nil {
		t.Fatalf("write baseline manifest: %v", err)
	}
	if err := os.WriteFile(target+"/skills/.bundled_manifest", []byte("base-skill:one\nfull-catalog:two\n"), 0o600); err != nil {
		t.Fatalf("write target bundled manifest: %v", err)
	}

	output, err := exec.Command("python3", "-c", alignBlankProfileSkillsScript, home, target).CombinedOutput()
	if err != nil {
		t.Fatalf("align blank profile skills: %v\n%s", err, output)
	}
	assertFileContents(t, target+"/skills/software-development/base-skill/SKILL.md", "seeded base")
	assertFileContents(t, target+"/skills/software-development/root-missing-base/SKILL.md", "seeded root-missing base")
	assertPathMissing(t, target+"/skills/software-development/full-catalog")
	assertPathMissing(t, target+"/skills/software-development/later-installed")
	assertFileContents(t, target+"/skills/.bundled_manifest", "base-skill:one\nfull-catalog:two\n")
}

func TestAlignBlankProfileSkillsInfersLegacyBuiltinsWithoutUserSkills(t *testing.T) {
	home := t.TempDir()
	target := home + "/profiles/profile-2"
	writeSkillFixture(t, home+"/skills/research/base-skill", "root base")
	writeSkillFixture(t, home+"/skills/website-builder", "root product skill")
	writeSkillFixture(t, home+"/skills/research/later-installed", "root user")
	if err := os.WriteFile(home+"/skills/.bundled_manifest", []byte("base-skill:one\nmissing-bundled:two\n"), 0o600); err != nil {
		t.Fatalf("write root bundled manifest: %v", err)
	}
	writeSkillFixture(t, target+"/skills/research/base-skill", "seeded base")
	writeSkillFixture(t, target+"/skills/research/missing-bundled", "seeded extra")

	output, err := exec.Command("python3", "-c", alignBlankProfileSkillsScript, home, target).CombinedOutput()
	if err != nil {
		t.Fatalf("align legacy blank profile skills: %v\n%s", err, output)
	}
	assertFileContents(t, target+"/skills/research/base-skill/SKILL.md", "seeded base")
	assertFileContents(t, target+"/skills/website-builder/SKILL.md", "root product skill")
	assertPathMissing(t, target+"/skills/research/missing-bundled")
	assertPathMissing(t, target+"/skills/research/later-installed")
}

func TestAlignBlankProfileSkillsRejectsMissingBaseline(t *testing.T) {
	home := t.TempDir()
	target := home + "/profiles/profile-2"
	writeSkillFixture(t, target+"/skills/research/full-catalog", "seeded extra")
	output, err := exec.Command("python3", "-c", alignBlankProfileSkillsScript, home, target).CombinedOutput()
	if err == nil || !strings.Contains(string(output), "LightVela base skills could not be resolved") {
		t.Fatalf("expected missing baseline failure, err=%v, output=%s", err, output)
	}
	assertFileContents(t, target+"/skills/research/full-catalog/SKILL.md", "seeded extra")
}

func writeSkillFixture(t *testing.T, directory, contents string) {
	t.Helper()
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatalf("create skill directory: %v", err)
	}
	if err := os.WriteFile(directory+"/SKILL.md", []byte(contents), 0o600); err != nil {
		t.Fatalf("write skill fixture: %v", err)
	}
}

func assertFileContents(t *testing.T, path, expected string) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(contents) != expected {
		t.Fatalf("%s = %q, want %q", path, contents, expected)
	}
}

func assertPathMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be absent, stat error = %v", path, err)
	}
}

func TestHermesProfileConfigUnsetOnlyIgnoresMissingKey(t *testing.T) {
	binDir := t.TempDir()
	hermesPath := binDir + "/hermes"
	fakeHermes := `#!/bin/sh
case "$FAKE_HERMES_RESULT" in
  missing)
    printf 'Config key not set: %s\n' "$5" >&2
    exit 1
    ;;
  failed)
    printf 'could not parse config\n' >&2
    exit 1
    ;;
esac
`
	if err := os.WriteFile(hermesPath, []byte(fakeHermes), 0o700); err != nil {
		t.Fatalf("write fake hermes: %v", err)
	}

	command := buildHermesProfileConfigUnsetCommand("profile-2", "gateway.platforms")
	for _, test := range []struct {
		name      string
		result    string
		wantError bool
	}{
		{name: "unset succeeds"},
		{name: "missing key is already clean", result: "missing"},
		{name: "other failures remain fatal", result: "failed", wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			cmd := exec.Command("/bin/bash", "-c", command)
			cmd.Env = append(os.Environ(), "PATH="+binDir+":"+os.Getenv("PATH"), "FAKE_HERMES_RESULT="+test.result)
			err := cmd.Run()
			if test.wantError && err == nil {
				t.Fatal("expected config failure to remain fatal")
			}
			if !test.wantError && err != nil {
				t.Fatalf("unexpected unset failure: %v", err)
			}
		})
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

func TestListHermesProfilesScriptKeepsGatewayRunningTriState(t *testing.T) {
	if !strings.Contains(listHermesProfilesScript, `bool(profile["gateway_running"]) if "gateway_running" in profile else None`) {
		t.Fatal("gateway_running must stay tri-state; a missing field has to surface as null, not false")
	}
}

func TestExecHermesProfileCommandUsesTAT(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		ptyEvents: []psandbox.PtyExecStreamEvent{
			{Type: "started", ExecutionID: "pty:profile"},
			{Type: "output", ExecutionID: "pty:profile", Index: 0, Chunk: "profile-ok\n"},
			{Type: "finished", ExecutionID: "pty:profile", Status: "SUCCESS", ExitCode: 0},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}

	resp, err := logic.execHermesProfileCommand(
		pctx.NewContext(nil).WithUserID("user-1"),
		"ins-1",
		"printf profile-ok",
	)
	if err != nil {
		t.Fatalf("execute Hermes profile command: %v", err)
	}
	if resp == nil || resp.Status != "SUCCESS" || resp.Output != "profile-ok\n" {
		t.Fatalf("unexpected Hermes profile response: %+v", resp)
	}
	if len(adapter.ptyCalls) != 1 || len(adapter.processCalls) != 0 {
		t.Fatalf("Hermes profile command must use TAT PTY only, pty=%d envd=%d", len(adapter.ptyCalls), len(adapter.processCalls))
	}
}

func TestProjectHermesProfilesPropagatesUnknownGatewayState(t *testing.T) {
	running := true
	bots := projectHermesProfiles([]hermesProfileRecord{
		{NativeID: defaultHermesProfileID, IsDefault: true},
		{NativeID: "profile-sales", GatewayRunning: &running},
	}, "ins-1", "")
	if bots[0].GatewayRunning != nil {
		t.Fatalf("unknown gateway state must stay nil, got %v", *bots[0].GatewayRunning)
	}
	if bots[1].GatewayRunning == nil || !*bots[1].GatewayRunning {
		t.Fatalf("known gateway state must be preserved: %+v", bots[1].GatewayRunning)
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

func TestProjectHermesProfilesLeavesUnnamedDefaultForLocalizedClientFallback(t *testing.T) {
	bots := projectHermesProfiles([]hermesProfileRecord{
		{NativeID: defaultHermesProfileID, IsDefault: true},
		{NativeID: "profile-sales"},
	}, "ins-1", "")
	if len(bots) != 2 {
		t.Fatalf("expected two bots, got %d", len(bots))
	}
	if bots[0].Name != "" {
		t.Fatalf("default bot leaked internal profile id as display name: %+v", bots[0])
	}
	if bots[1].Name != "profile-sales" {
		t.Fatalf("named bot should keep the native profile id fallback: %+v", bots[1])
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

func TestValidateInstanceBotTextEnforcesNameRuneLimit(t *testing.T) {
	const expectedMaxNameRunes = 60
	if maxInstanceBotNameRunes != expectedMaxNameRunes {
		t.Fatalf("Bot name limit = %d, want %d", maxInstanceBotNameRunes, expectedMaxNameRunes)
	}

	validName := strings.Repeat("名", expectedMaxNameRunes)
	name, _, err := validateInstanceBotText(validName, "")
	if err != nil || name != validName {
		t.Fatalf("expected %d-rune name to be valid, got name %q, err %v", expectedMaxNameRunes, name, err)
	}

	tooLongName := validName + "字"
	if _, _, err := validateInstanceBotText(tooLongName, ""); !errors.Is(err, errcode.ErrInstanceBotInvalidParam) {
		t.Fatalf("expected %d-rune name to be rejected, got %v", expectedMaxNameRunes+1, err)
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

func TestChannelBindingScriptIsolatesWeixinOwnersAndPreservesConnectedBinding(t *testing.T) {
	home := t.TempDir()
	run := func(channel, action, botID, profileID string) channelBindingPayload {
		t.Helper()
		profileHome := home
		if profileID != "default" {
			profileHome = filepath.Join(home, "profiles", profileID)
		}
		if action == "confirm" {
			if err := os.MkdirAll(profileHome, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(profileHome, ".env"), []byte("WEIXIN_ACCOUNT_ID="+botID+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if action == "release" {
			_ = os.Remove(filepath.Join(profileHome, ".env"))
		}
		command := exec.Command("python3", "-c", manageChannelBindingScript, action, channel, botID, profileID, "default-bot")
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

	if claim := run("weixin", "claim", "bot-1", "profile-1"); !claim.OK || claim.Status != "reserved" {
		t.Fatalf("unexpected first claim: %+v", claim)
	}
	if claim := run("weixin", "claim", "bot-2", "profile-2"); !claim.OK || claim.BotID != "bot-2" {
		t.Fatalf("another Profile must claim its own Weixin account: %+v", claim)
	}
	if occupied := run("weixin", "claim", "bot-3", "profile-1"); occupied.OK || occupied.Reason != "occupied" || occupied.BotID != "bot-1" {
		t.Fatalf("the same Profile must reject a second Bot: %+v", occupied)
	}
	if claim := run("whatsapp", "claim", "bot-2", "profile-2"); !claim.OK || claim.Channel != "whatsapp" || claim.BotID != "bot-2" {
		t.Fatalf("independent WhatsApp claim failed: %+v", claim)
	}
	if occupied := run("whatsapp", "claim", "bot-1", "profile-1"); occupied.OK || occupied.Reason != "occupied" || occupied.BotID != "bot-2" {
		t.Fatalf("expected WhatsApp to be occupied by bot-2, got %+v", occupied)
	}
	if confirmed := run("weixin", "confirm", "bot-1", "profile-1"); !confirmed.OK || confirmed.Status != "connected" {
		t.Fatalf("unexpected confirmation: %+v", confirmed)
	}
	run("weixin", "release_reserved", "bot-1", "profile-1")
	if current := run("weixin", "get", "", "profile-1"); current.BotID != "bot-1" || current.Status != "connected" {
		t.Fatalf("connected owner must survive reserved cleanup: %+v", current)
	}
	if current := run("weixin", "get", "", "profile-2"); current.BotID != "bot-2" {
		t.Fatalf("the second Profile lost its Weixin owner: %+v", current)
	}
	run("weixin", "release", "bot-1", "profile-1")
	if current := run("weixin", "get", "", "profile-1"); current.BotID != "" {
		t.Fatalf("expected released binding, got %+v", current)
	}
	if current := run("weixin", "get", "", "profile-2"); current.BotID != "bot-2" {
		t.Fatalf("releasing the first Profile changed the second: %+v", current)
	}
	if current := run("whatsapp", "get", "", ""); current.BotID != "bot-2" {
		t.Fatalf("Weixin release changed WhatsApp owner: %+v", current)
	}
}

func TestChannelBindingScriptPreservesLegacyWeixinOwnerWhenAnotherBotConnects(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, ".lightvela", "channel-bindings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"ok":true,"channel":"weixin","bot_id":"bot-1","profile_id":"profile-1","status":"connected"}`
	if err := os.WriteFile(filepath.Join(root, "weixin.json"), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(action, botID, profileID string) channelBindingPayload {
		t.Helper()
		command := exec.Command("python3", "-c", manageChannelBindingScript, action, "weixin", botID, profileID, "default-bot")
		command.Env = append(os.Environ(), "HERMES_HOME="+home)
		output, err := command.Output()
		if err != nil {
			t.Fatal(err)
		}
		var result channelBindingPayload
		if err := json.Unmarshal(output, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if claim := run("claim", "bot-2", "profile-2"); !claim.OK || claim.BotID != "bot-2" {
		t.Fatalf("second Profile cannot claim Weixin: %+v", claim)
	}
	if owner := run("get", "", "profile-1"); owner.BotID != "bot-1" || owner.Status != "connected" {
		t.Fatalf("legacy owner was lost: %+v", owner)
	}
	data, err := os.ReadFile(filepath.Join(root, "weixin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		Bindings map[string]channelBindingPayload `json:"bindings"`
	}
	if err := json.Unmarshal(data, &stored); err != nil || len(stored.Bindings) != 2 {
		t.Fatalf("legacy binding was not migrated with the new one: %s %v", data, err)
	}
}

func TestWhatsAppBindingAdoptsLegacyDefaultSessionOnce(t *testing.T) {
	home := t.TempDir()
	session := filepath.Join(home, "whatsapp", "session")
	if err := os.MkdirAll(session, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(session, "creds.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, ".lightvela", "channel-bindings")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	// Earlier versions checked the wrong path and may have already written this marker.
	if err := os.WriteFile(filepath.Join(root, "whatsapp-legacy-checked"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(action, botID string) channelBindingPayload {
		t.Helper()
		command := exec.Command("python3", "-c", manageChannelBindingScript, action, "whatsapp", botID, "default", "default-bot")
		command.Env = append(os.Environ(), "HERMES_HOME="+home)
		output, err := command.Output()
		if err != nil {
			t.Fatal(err)
		}
		var payload channelBindingPayload
		if err := json.Unmarshal(output, &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	if current := run("get", ""); current.BotID != "default-bot" || current.Status != "connected" {
		t.Fatalf("legacy session should belong to default bot: %+v", current)
	}
	if occupied := run("claim", "another-bot"); occupied.OK || occupied.Reason != "occupied" {
		t.Fatalf("legacy session must block another bot: %+v", occupied)
	}
	if err := os.Remove(filepath.Join(session, "creds.json")); err != nil {
		t.Fatal(err)
	}
	run("disconnect", "default-bot")
	if current := run("get", ""); current.BotID != "" {
		t.Fatalf("legacy session should not be adopted again after release: %+v", current)
	}
}

func runWhatsAppBindingForTest(t *testing.T, home, action, botID, reservationID string) channelBindingPayload {
	t.Helper()
	command := exec.Command("python3", "-c", manageChannelBindingScript, action, "whatsapp", botID, "profile-1", "default-bot", reservationID)
	command.Env = append(os.Environ(), "HERMES_HOME="+home)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("binding %s: %v", action, err)
	}
	var payload channelBindingPayload
	if err := json.Unmarshal(output, &payload); err != nil {
		t.Fatalf("decode binding %s: %v", action, err)
	}
	return payload
}

func writeWhatsAppCredentialsForTest(t *testing.T, home string) string {
	t.Helper()
	path := filepath.Join(home, "profiles", "profile-1", "whatsapp", "session", "creds.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"me":{"id":"test@s.whatsapp.net"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWhatsAppMixedOldFrontendAndTokenClient(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	if !claim.OK || claim.ReservationID == "" {
		t.Fatalf("first scan must reserve: %+v", claim)
	}
	if confirmed := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", ""); confirmed.OK {
		t.Fatalf("legacy confirm without actual credentials must fail: %+v", confirmed)
	}
	if confirmed := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", claim.ReservationID); confirmed.OK {
		t.Fatalf("token confirm without actual credentials must fail: %+v", confirmed)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	if concurrent := runWhatsAppBindingForTest(t, home, "claim", "bot-1", ""); concurrent.OK {
		t.Fatalf("legacy rollback must not release an in-flight scan: %+v", concurrent)
	}
	credentials := writeWhatsAppCredentialsForTest(t, home)
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.Status != "reserved" || current.ReservationID != claim.ReservationID {
		t.Fatalf("ambiguous legacy rollback must not alter a scanned-but-unconfirmed lease: %+v", current)
	}
	if wrong := runWhatsAppBindingForTest(t, home, "confirm", "bot-2", ""); wrong.OK {
		t.Fatalf("another bot confirmed a legacy scan: %+v", wrong)
	}
	if wrong := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", "bad-token"); wrong.OK {
		t.Fatalf("token client bypassed lease ownership: %+v", wrong)
	}
	if confirmed := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", ""); !confirmed.OK || confirmed.Status != "connected" {
		t.Fatalf("legacy scan with same-bot credentials could not confirm: %+v", confirmed)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	runWhatsAppBindingForTest(t, home, "release", "bot-1", claim.ReservationID)
	if disconnect := runWhatsAppBindingForTest(t, home, "disconnect", "bot-1", ""); disconnect.OK {
		t.Fatalf("explicit disconnect must not release present credentials: %+v", disconnect)
	}
	if occupied := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); occupied.OK {
		t.Fatalf("legacy release or premature disconnect lost an active owner: %+v", occupied)
	}
	if err := os.Remove(credentials); err != nil {
		t.Fatal(err)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "" {
		t.Fatalf("legacy disconnect with missing credentials did not clear owner: %+v", current)
	}
	if next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); !next.OK || next.ReservationID == "" {
		t.Fatalf("disconnected binding did not clear safely: %+v", next)
	}
}

func TestWhatsAppRollbackAfterCredentialWriteKeepsOwner(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	writeWhatsAppCredentialsForTest(t, home)
	runWhatsAppBindingForTest(t, home, "release", "bot-1", claim.ReservationID)
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-1" || current.Status != "connected" {
		t.Fatalf("late rollback removed actual connected credentials: %+v", current)
	}
	if next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); next.OK {
		t.Fatalf("another bot claimed a connected session: %+v", next)
	}
}

func TestWhatsAppLegacyDisconnectAllowsSameBotReconnect(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	credentials := writeWhatsAppCredentialsForTest(t, home)
	if confirmed := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", ""); !confirmed.OK {
		t.Fatalf("initial old-browser scan did not confirm: %+v", confirmed)
	}
	if err := os.Remove(credentials); err != nil {
		t.Fatal(err)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	if reconnect := runWhatsAppBindingForTest(t, home, "claim", "bot-1", ""); !reconnect.OK || reconnect.Status != "reserved" || reconnect.ReservationID == claim.ReservationID {
		t.Fatalf("same Bot could not safely resume after old-browser disconnect: %+v", reconnect)
	}
	if blocked := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); blocked.OK {
		t.Fatalf("another Bot bypassed reconnect reservation: %+v", blocked)
	}
}

func TestWhatsAppLegacyRequestsReachBindingAndDisconnectRejectsPresentCredentials(t *testing.T) {
	batch := func(body string) []psandbox.PtyExecStreamEvent {
		return []psandbox.PtyExecStreamEvent{
			{Type: "output", Chunk: body},
			{Type: "finished", ExitCode: 0, Status: "SUCCESS"},
		}
	}
	adapter := &commandSandboxAdapterStub{ptyBatches: [][]psandbox.PtyExecStreamEvent{
		batch(`{"items":[{"native_id":"default","display_name":"Main","is_default":true}]}`),
		batch(`{"ok":true,"channel":"whatsapp","bot_id":"ins-1","status":"connected"}`),
		batch(`{"items":[{"native_id":"default","display_name":"Main","is_default":true}]}`),
		batch(`{"ok":true}`),
		batch(`{"items":[{"native_id":"default","display_name":"Main","is_default":true}]}`),
		batch(`{"ok":false,"reason":"credentials_present"}`),
	}}
	l := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	ctx := pctx.NewContext(nil).WithUserID("user-1")
	if err := l.ConfirmInstanceBotChannel(ctx, "ins-1", "ins-1", "whatsapp", ""); err != nil {
		t.Fatalf("old frontend no-body confirm rejected before state machine: %v", err)
	}
	if err := l.ReleaseInstanceBotChannel(ctx, "ins-1", "ins-1", "whatsapp", "", false); err != nil {
		t.Fatalf("old frontend no-body release rejected before state machine: %v", err)
	}
	if err := l.ReleaseInstanceBotChannel(ctx, "ins-1", "ins-1", "whatsapp", "", true); !errors.Is(err, errcode.ErrInstanceBotConflict) {
		t.Fatalf("explicit disconnect must surface credentials-present conflict: %v", err)
	}
	if got := len(adapter.ptyCalls); got != 6 {
		t.Fatalf("expected all 3 legacy/mixed actions to reach CTL, got %d calls", got)
	}
}

func TestWhatsAppBindingConcurrentClaimsAndStaleRelease(t *testing.T) {
	home := t.TempDir()
	first := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	if !first.OK || first.ReservationID == "" || first.Status != "reserved" {
		t.Fatalf("first claim must issue an owned reservation: %+v", first)
	}
	if concurrent := runWhatsAppBindingForTest(t, home, "claim", "bot-1", ""); concurrent.OK {
		t.Fatalf("second scan for same bot must not replace active reservation: %+v", concurrent)
	}
	if wrong := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", "wrong"); wrong.OK {
		t.Fatalf("wrong reservation must not confirm: %+v", wrong)
	}
	credentials := writeWhatsAppCredentialsForTest(t, home)
	if confirmed := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", first.ReservationID); !confirmed.OK || confirmed.Status != "connected" {
		t.Fatalf("first scan could not confirm: %+v", confirmed)
	}
	reconnect := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	if !reconnect.OK || reconnect.ReservationID == "" || reconnect.ReservationID == first.ReservationID || reconnect.Status != "reserved" {
		t.Fatalf("re-scan must be serialized by a fresh lease: %+v", reconnect)
	}
	if old := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", ""); old.OK {
		t.Fatalf("stale no-token confirm consumed a newer scan using old credentials: %+v", old)
	}
	if concurrent := runWhatsAppBindingForTest(t, home, "claim", "bot-1", ""); concurrent.OK {
		t.Fatalf("another re-scan bypassed the active lease: %+v", concurrent)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", first.ReservationID)
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-1" || current.Status != "reserved" || current.ReservationID != reconnect.ReservationID {
		t.Fatalf("stale failed scan replaced new lease: %+v", current)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", reconnect.ReservationID)
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-1" || current.Status != "connected" {
		t.Fatalf("rollback with existing credentials must restore connected owner: %+v", current)
	}
	if occupied := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); occupied.OK {
		t.Fatalf("different bot claimed an active session: %+v", occupied)
	}
	if err := os.Remove(credentials); err != nil {
		t.Fatal(err)
	}
	runWhatsAppBindingForTest(t, home, "disconnect", "bot-1", "")
	if next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); !next.OK || next.ReservationID == "" {
		t.Fatalf("disconnected owner still blocked another bot: %+v", next)
	}
}

func TestWhatsAppConcurrentClaimsSerializeAcrossProcesses(t *testing.T) {
	home := t.TempDir()
	start := make(chan struct{})
	results := make(chan channelBindingPayload, 2)
	for _, botID := range []string{"bot-1", "bot-2"} {
		go func(botID string) {
			<-start
			command := exec.Command("python3", "-c", manageChannelBindingScript, "claim", "whatsapp", botID, botID, "default-bot", "")
			command.Env = append(os.Environ(), "HERMES_HOME="+home)
			output, err := command.Output()
			var result channelBindingPayload
			if err == nil {
				err = json.Unmarshal(output, &result)
			}
			if err != nil {
				result.Reason = err.Error()
			}
			results <- result
		}(botID)
	}
	close(start)
	first, second := <-results, <-results
	if first.OK == second.OK {
		t.Fatalf("exactly one concurrent claim should succeed: %+v %+v", first, second)
	}
	winner, loser := first, second
	if !winner.OK {
		winner, loser = loser, winner
	}
	if winner.ReservationID == "" || loser.Reason != "occupied" || loser.BotID != winner.BotID {
		t.Fatalf("concurrent claim lost exclusive ownership: winner=%+v loser=%+v", winner, loser)
	}
}

func TestWhatsAppAbandonedReservationExpires(t *testing.T) {
	home := t.TempDir()
	first := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	if !first.OK || first.ReservationID == "" {
		t.Fatalf("missing initial reservation: %+v", first)
	}
	path := filepath.Join(home, ".lightvela", "channel-bindings", "whatsapp.json")
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var binding map[string]any
	if err := json.Unmarshal(value, &binding); err != nil {
		t.Fatal(err)
	}
	binding["updated_at"] = "2000-01-01T00:00:00+00:00"
	value, err = json.Marshal(binding)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
	next := runWhatsAppBindingForTest(t, home, "claim", "bot-2", "")
	if !next.OK || next.BotID != "bot-2" || next.ReservationID == "" {
		t.Fatalf("abandoned reservation did not recover: %+v", next)
	}
	if old := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", first.ReservationID); old.OK {
		t.Fatalf("expired scanner confirmed over new owner: %+v", old)
	}
	if old := runWhatsAppBindingForTest(t, home, "confirm", "bot-1", ""); old.OK {
		t.Fatalf("expired legacy scanner confirmed over new owner: %+v", old)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", "")
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-2" || current.ReservationID != next.ReservationID {
		t.Fatalf("expired legacy rollback altered new reservation: %+v", current)
	}
}

func TestWhatsAppAbandonedAfterScanKeepsConnectedOwner(t *testing.T) {
	home := t.TempDir()
	claim := runWhatsAppBindingForTest(t, home, "claim", "bot-1", "")
	if !claim.OK || claim.ReservationID == "" {
		t.Fatalf("missing initial reservation: %+v", claim)
	}
	session := filepath.Join(home, "profiles", "profile-1", "whatsapp", "session")
	if err := os.MkdirAll(session, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(session, "creds.json"), []byte(`{"me":{"id":"test@s.whatsapp.net"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".lightvela", "channel-bindings", "whatsapp.json")
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var binding map[string]any
	if err := json.Unmarshal(value, &binding); err != nil {
		t.Fatal(err)
	}
	binding["updated_at"] = "2000-01-01T00:00:00+00:00"
	value, err = json.Marshal(binding)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
	if current := runWhatsAppBindingForTest(t, home, "get", "", ""); current.BotID != "bot-1" || current.Status != "connected" || current.ReservationID != "" {
		t.Fatalf("abandoned successful scan must preserve owner: %+v", current)
	}
	runWhatsAppBindingForTest(t, home, "release", "bot-1", claim.ReservationID)
	if occupied := runWhatsAppBindingForTest(t, home, "claim", "bot-2", ""); occupied.OK {
		t.Fatalf("another bot took a connected session: %+v", occupied)
	}
}

func TestDeleteInstanceBotRejectsDefaultBot(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		ptyBatches: [][]psandbox.PtyExecStreamEvent{{
			{Type: "output", Chunk: `{"items":[{"native_id":"default","display_name":"Main","is_default":true}]}`},
			{Type: "finished", ExitCode: 0, Status: "SUCCESS"},
		}},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}

	_, err := logic.DeleteInstanceBot(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", "ins-1")
	if !errors.Is(err, errcode.ErrInstanceBotDefaultDelete) {
		t.Fatalf("expected default Bot delete rejection, got %v", err)
	}
	if len(adapter.ptyCalls) != 1 || len(adapter.processCalls) != 0 {
		t.Fatalf("default Bot rejection must only run one TAT lookup, pty=%d envd=%d", len(adapter.ptyCalls), len(adapter.processCalls))
	}
}

func TestDeleteInstanceBotRejectsWeixinOwner(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		ptyBatches: [][]psandbox.PtyExecStreamEvent{
			{
				{Type: "output", Chunk: `{"items":[{"native_id":"sales-123","display_name":"Sales","is_default":false}]}`},
				{Type: "finished", ExitCode: 0, Status: "SUCCESS"},
			},
			{
				{Type: "output", Chunk: `{"ok":true,"channel":"weixin","bot_id":"sales-123","profile_id":"sales-123","status":"connected"}`},
				{Type: "finished", ExitCode: 0, Status: "SUCCESS"},
			},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}

	_, err := logic.DeleteInstanceBot(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", "sales-123")
	if !errors.Is(err, errcode.ErrChannelOccupied) {
		t.Fatalf("expected connected Weixin owner rejection, got %v", err)
	}
	if len(adapter.ptyCalls) != 2 || len(adapter.processCalls) != 0 {
		t.Fatalf("connected Weixin owner rejection must only use TAT lookups, pty=%d envd=%d", len(adapter.ptyCalls), len(adapter.processCalls))
	}
	if !strings.Contains(adapter.ptyCalls[1].Command, "sales-123") {
		t.Fatal("delete guard must query the Bot's Weixin profile")
	}
}

func TestDeleteInstanceBotRejectsWhatsAppOwner(t *testing.T) {
	adapter := &commandSandboxAdapterStub{
		ptyBatches: [][]psandbox.PtyExecStreamEvent{
			{{Type: "output", Chunk: `{"items":[{"native_id":"sales-123","display_name":"Sales","is_default":false}]}`}, {Type: "finished", ExitCode: 0, Status: "SUCCESS"}},
			{{Type: "output", Chunk: `{"ok":true}`}, {Type: "finished", ExitCode: 0, Status: "SUCCESS"}},
			{{Type: "output", Chunk: `{"ok":true,"channel":"whatsapp","bot_id":"sales-123","profile_id":"sales-123","status":"connected"}`}, {Type: "finished", ExitCode: 0, Status: "SUCCESS"}},
		},
	}
	logic := &logic{
		instanceDao: &commandInstanceDaoStub{entity: &modelinstance.Entity{
			InstanceId: "ins-1", SandboxId: "sbx-1", Status: modelinstance.InstanceStatusRunning,
		}},
		sandboxAdapter: adapter,
		logger:         zap.NewNop(),
	}
	_, err := logic.DeleteInstanceBot(pctx.NewContext(nil).WithUserID("user-1"), "ins-1", "sales-123")
	if !errors.Is(err, errcode.ErrChannelOccupied) {
		t.Fatalf("expected connected WhatsApp owner rejection, got %v", err)
	}
	if len(adapter.ptyCalls) != 3 {
		t.Fatalf("expected profile and both channel binding lookups, got %d", len(adapter.ptyCalls))
	}
}

func TestShellQuoteEscapesProfileInput(t *testing.T) {
	if got := shellQuote("team's-bot"); got != "'team'\\''s-bot'" {
		t.Fatalf("unexpected shell quote: %q", got)
	}
}
