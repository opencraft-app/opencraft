package rescue

import (
	"strings"
	"testing"
)

func TestBuildArchiveScriptUsesReadOnlyMountAndPaths(t *testing.T) {
	req := ExportRequest{
		InstanceID:    "ins-0fverxpd",
		RemoteWorkDir: "/tmp",
		MountRoot:     "/mnt/rescue-root",
		DeviceGlobs:   []string{"/dev/vda*"},
		RemotePaths:   []string{"/etc", "/var/lib/app data"},
	}
	script := BuildArchiveScript(req)
	for _, want := range []string{"mount -o ro,noload", "tar --numeric-owner --one-file-system", "/dev/vda*", "/var/lib/app data", "RESCUE_EXPORT_RESULT="} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q:\n%s", want, script)
		}
	}
}

func TestParseArchiveMarker(t *testing.T) {
	marker, err := ParseArchiveMarker(`noise
RESCUE_EXPORT_RESULT={"archive":"/tmp/a.tar.gz","device":"/dev/vda1","bytes":12,"sha256":"abc"}
`)
	if err != nil {
		t.Fatal(err)
	}
	if marker.Archive != "/tmp/a.tar.gz" || marker.Device != "/dev/vda1" || marker.Bytes != 12 || marker.SHA256 != "abc" {
		t.Fatalf("unexpected marker: %+v", marker)
	}
}

func TestParseUploadMarker(t *testing.T) {
	marker, err := ParseUploadMarker(`noise
RESCUE_UPLOAD_RESULT={"object_url":"https://bucket.cos.ap-beijing.myqcloud.com/a.tgz","device":"/dev/vda1","bytes":34,"sha256":"def"}
`)
	if err != nil {
		t.Fatal(err)
	}
	if marker.ObjectURL == "" || marker.Device != "/dev/vda1" || marker.Bytes != 34 || marker.SHA256 != "def" {
		t.Fatalf("unexpected marker: %+v", marker)
	}
}

func TestBuildUploaderRunScript(t *testing.T) {
	script := BuildUploaderRunScript("https://example.com/uploader?q=1", `{"upload_url":"https://example.com/archive"}`)
	for _, want := range []string{"curl -fL", "wget -O rescue-uploader", "./rescue-uploader config.json", "RESCUE_UPLOADER_CONFIG"} {
		if !strings.Contains(script, want) {
			t.Fatalf("script missing %q:\n%s", want, script)
		}
	}
}

func TestBuildSCPCommand(t *testing.T) {
	req := ExportRequest{SSHUser: "root", SSHPort: 2222, SSHIdentityFile: "~/.ssh/id_rsa"}
	cmd := BuildSCPCommand(req, "1.2.3.4", "/tmp/a.tar.gz", "/out/a.tar.gz")
	joined := strings.Join(cmd, " ")
	for _, want := range []string{"ssh-native-copy", "-P 2222", "root@1.2.3.4:/tmp/a.tar.gz", "/out/a.tar.gz"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("command missing %q: %s", want, joined)
		}
	}
}

func TestBuildSSHCommandOmitsBatchModeForPasswordAuth(t *testing.T) {
	req := ExportRequest{SSHUser: "root", SSHPort: 22, SSHPasswordEnv: "RESCUE_SSH_PASSWORD"}
	cmd := BuildSSHCommand(req, "1.2.3.4", "true")
	joined := strings.Join(cmd, " ")
	if strings.Contains(joined, "BatchMode=yes") {
		t.Fatalf("password auth must not force BatchMode=yes: %s", joined)
	}
	if !strings.Contains(joined, "ssh-native") {
		t.Fatalf("command missing native marker: %s", joined)
	}
}
