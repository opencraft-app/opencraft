package instance

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type weixinFixture struct {
	t         *testing.T
	home, bin string
}

func newWeixinFixture(t *testing.T) *weixinFixture {
	t.Helper()
	if err := exec.Command("python3", "-c", "import dotenv").Run(); err != nil {
		t.Skip("python-dotenv unavailable")
	}
	f := &weixinFixture{t: t, home: t.TempDir(), bin: t.TempDir()}
	f.write(filepath.Join(f.bin, "acli"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HERMES_HOME/.acli-calls\"\n", 0700)
	return f
}
func (f *weixinFixture) write(path, value string, mode os.FileMode) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), mode); err != nil {
		f.t.Fatal(err)
	}
}
func (f *weixinFixture) profile(profile string) string {
	if profile == "default" {
		return f.home
	}
	return filepath.Join(f.home, "profiles", profile)
}
func (f *weixinFixture) credentials(profile, account, user string) {
	f.write(filepath.Join(f.profile(profile), ".env"), "OTHER_SETTING=keep\nWEIXIN_ACCOUNT_ID="+account+"\nWEIXIN_TOKEN=synthetic-test-token\n", 0600)
	value, _ := json.Marshal(map[string]string{"user_id": user, "token": "synthetic-test-token"})
	f.write(filepath.Join(f.profile(profile), "weixin", "accounts", account+".json"), string(value), 0600)
}
func (f *weixinFixture) run(action, bot, profile, lease string) channelBindingPayload {
	f.t.Helper()
	cmd := exec.Command("python3", "-c", manageChannelBindingScript, action, "weixin", bot, profile, "instance-test", lease)
	cmd.Env = append(os.Environ(), "HERMES_HOME="+f.home, "PATH="+f.bin+":"+os.Getenv("PATH"), "PYTHONPATH="+f.bin+":"+os.Getenv("PYTHONPATH"))
	output, err := cmd.CombinedOutput()
	if err != nil {
		f.t.Fatalf("binding %s failed: %v (%s)", action, err, output)
	}
	var result channelBindingPayload
	if err := json.Unmarshal(output, &result); err != nil {
		f.t.Fatal(err)
	}
	return result
}
func (f *weixinFixture) connect(bot, profile, account, user string) {
	f.t.Helper()
	claim := f.run("claim", bot, profile, "")
	if !claim.OK {
		f.t.Fatalf("claim: %+v", claim)
	}
	f.credentials(profile, account, user)
	result := f.run("confirm", bot, profile, claim.ReservationID)
	if !result.OK {
		f.t.Fatalf("confirm: %+v", result)
	}
}
func TestWeixinAccountRejectsDuplicateAndRollsBackOnlyScanningBot(t *testing.T) {
	for _, kind := range []string{"account_id", "user_id"} {
		t.Run(kind, func(t *testing.T) {
			f := newWeixinFixture(t)
			f.connect("bot-a", "default", "account-a", "user-a")
			f.write(filepath.Join(f.profile("profile-b"), ".env"), "OTHER_SETTING=keep\n", 0600)
			claim := f.run("claim", "bot-b", "profile-b", "")
			account := "account-a"
			if kind == "user_id" {
				account = "new-login-id"
			}
			f.credentials("profile-b", account, "user-a")
			rejected := f.run("confirm", "bot-b", "profile-b", claim.ReservationID)
			if rejected.OK || rejected.Reason != "account_occupied" || rejected.BotID != "bot-a" {
				t.Fatalf("unexpected conflict: %+v", rejected)
			}
			if a := f.run("get", "bot-a", "default", ""); a.Status != "connected" {
				t.Fatalf("owner changed: %+v", a)
			}
			if b := f.run("get", "bot-b", "profile-b", ""); b.BotID != "" {
				t.Fatalf("rejected binding retained: %+v", b)
			}
			env, _ := os.ReadFile(filepath.Join(f.profile("profile-b"), ".env"))
			if strings.Contains(string(env), "WEIXIN_") || !strings.Contains(string(env), "OTHER_SETTING=keep") {
				t.Fatal("profile env was not restored")
			}
			calls, _ := os.ReadFile(filepath.Join(f.home, ".acli-calls"))
			if !strings.Contains(string(calls), "stop --agent profile-b") || strings.Contains(string(calls), "--agent main") {
				t.Fatal("rollback manipulated wrong gateway")
			}
		})
	}
}
func TestWeixinDistinctAccountsAndFailedReconnectRestore(t *testing.T) {
	f := newWeixinFixture(t)
	f.connect("bot-a", "default", "account-a", "user-a")
	f.connect("bot-b", "profile-b", "account-b", "user-b")
	claim := f.run("claim", "bot-b", "profile-b", "")
	f.credentials("profile-b", "account-a", "user-a")
	if result := f.run("confirm", "bot-b", "profile-b", claim.ReservationID); result.Reason != "account_occupied" {
		t.Fatalf("unexpected: %+v", result)
	}
	if b := f.run("get", "bot-b", "profile-b", ""); b.Status != "connected" {
		t.Fatal("previous binding lost")
	}
	env, _ := os.ReadFile(filepath.Join(f.profile("profile-b"), ".env"))
	if !strings.Contains(string(env), "account-b") {
		t.Fatal("previous account not restored")
	}
}
func TestWeixinStaleLeaseAndLegacyOwner(t *testing.T) {
	f := newWeixinFixture(t)
	f.credentials("default", "account-a", "user-a")
	f.write(filepath.Join(f.home, ".lightvela", "channel-bindings", "weixin.json"), `{"ok":true,"bot_id":"bot-a","profile_id":"default","status":"connected"}`, 0600)
	claim := f.run("claim", "bot-b", "profile-b", "")
	f.credentials("profile-b", "account-a", "user-a")
	if result := f.run("confirm", "bot-b", "profile-b", "stale"); result.OK {
		t.Fatal("stale confirm accepted")
	}
	f.run("release", "bot-b", "profile-b", "stale")
	if b := f.run("get", "bot-b", "profile-b", ""); b.Status != "reserved" {
		t.Fatal("stale release changed current scan")
	}
	if result := f.run("confirm", "bot-b", "profile-b", claim.ReservationID); result.Reason != "account_occupied" {
		t.Fatalf("legacy owner not adopted: %+v", result)
	}
}

func TestWeixinConcurrentConfirmOnlyOneOwnerWins(t *testing.T) {
	f := newWeixinFixture(t)
	a := f.run("claim", "bot-a", "default", "")
	b := f.run("claim", "bot-b", "profile-b", "")
	f.credentials("default", "same-account", "same-user")
	f.credentials("profile-b", "same-account", "same-user")
	commands := []*exec.Cmd{}
	for _, target := range []struct{ bot, profile, lease string }{{"bot-a", "default", a.ReservationID}, {"bot-b", "profile-b", b.ReservationID}} {
		cmd := exec.Command("python3", "-c", manageChannelBindingScript, "confirm", "weixin", target.bot, target.profile, "instance-test", target.lease)
		cmd.Env = append(os.Environ(), "HERMES_HOME="+f.home, "PATH="+f.bin+":"+os.Getenv("PATH"), "PYTHONPATH="+f.bin+":"+os.Getenv("PYTHONPATH"))
		commands = append(commands, cmd)
	}
	type outcome struct {
		output []byte
		err    error
	}
	results := make(chan outcome, 2)
	for _, cmd := range commands {
		go func(cmd *exec.Cmd) { out, err := cmd.CombinedOutput(); results <- outcome{out, err} }(cmd)
	}
	confirmed, conflicts := 0, 0
	for range commands {
		result := <-results
		if result.err != nil {
			t.Fatalf("confirm process: %v", result.err)
		}
		var binding channelBindingPayload
		if err := json.Unmarshal(result.output, &binding); err != nil {
			t.Fatal(err)
		}
		if binding.OK {
			confirmed++
		} else if binding.Reason == "account_occupied" {
			conflicts++
		}
	}
	if confirmed != 1 || conflicts != 1 {
		t.Fatalf("confirmed=%d conflicts=%d", confirmed, conflicts)
	}
}
func TestWeixinRollbackPreservesOtherPlatformConfig(t *testing.T) {
	if exec.Command("python3", "-c", "import yaml").Run() != nil {
		t.Skip("PyYAML unavailable")
	}
	f := newWeixinFixture(t)
	f.connect("bot-a", "default", "account-a", "user-a")
	f.write(filepath.Join(f.bin, "hermes_cli", "__init__.py"), "", 0600)
	f.write(filepath.Join(f.bin, "hermes_cli", "profiles.py"), "def _check_gateway_running(home): return True\n", 0600)
	f.write(filepath.Join(f.profile("profile-b"), "gateway.pid"), "synthetic", 0600)
	path := filepath.Join(f.profile("profile-b"), "config.yaml")
	f.write(path, "platforms:\n  feishu:\n    enabled: true\n", 0600)
	claim := f.run("claim", "bot-b", "profile-b", "")
	f.credentials("profile-b", "account-a", "user-a")
	f.write(path, "platforms:\n  feishu:\n    enabled: false\n  weixin:\n    extra:\n      account_id: account-a\n", 0600)
	if r := f.run("confirm", "bot-b", "profile-b", claim.ReservationID); r.Reason != "account_occupied" {
		t.Fatalf("unexpected: %+v", r)
	}
	config, _ := os.ReadFile(path)
	if strings.Contains(string(config), "weixin:") || !strings.Contains(string(config), "enabled: false") {
		t.Fatal("rollback changed another platform or retained Weixin config")
	}
	calls, _ := os.ReadFile(filepath.Join(f.home, ".acli-calls"))
	if !strings.Contains(string(calls), "restart --agent profile-b") {
		t.Fatal("previous gateway was not restored for other channels")
	}
}
