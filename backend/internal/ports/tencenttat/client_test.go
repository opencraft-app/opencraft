package tencenttat

import (
	"testing"
	"time"
)

func TestMacOSCanaryUsesShellAndAcceptsLinuxWireObservation(t *testing.T) {
	target := Target{
		Region:     "ap-beijing",
		InstanceID: "rins-macos-canary",
		OS:         OSMacOS,
	}
	if err := target.Validate(); err != nil {
		t.Fatalf("Target.Validate() error = %v", err)
	}
	command, err := NewCommand(CommandSpec{
		Template:         TemplateProbe,
		OperationID:      "019b1f49-c5e8-7d78-8c08-d39d35722e95",
		Target:           target,
		CommandType:      CommandShell,
		Content:          "true\n",
		WorkingDirectory: "/tmp",
		Username:         "root",
		Timeout:          time.Minute,
	})
	if err != nil {
		t.Fatalf("NewCommand() error = %v", err)
	}
	if command.Target().OS != OSMacOS ||
		command.CommandType() != CommandShell {
		t.Fatalf("command = %#v", command)
	}
	if !ObservedOSCompatible(OSMacOS, OSLinux) ||
		!ObservedOSCompatible(OSMacOS, OSMacOS) ||
		ObservedOSCompatible(OSMacOS, OSWindows) ||
		ObservedOSCompatible(OSLinux, OSMacOS) {
		t.Fatal("macOS Canary wire compatibility matrix is invalid")
	}
}
