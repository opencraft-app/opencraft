package instance

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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
}

func TestShellQuoteEscapesProfileInput(t *testing.T) {
	if got := shellQuote("team's-bot"); got != "'team'\\''s-bot'" {
		t.Fatalf("unexpected shell quote: %q", got)
	}
}
