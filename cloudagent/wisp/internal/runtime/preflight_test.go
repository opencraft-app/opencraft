package runtime

import (
	"path/filepath"
	"reflect"
	"testing"

	"wisp/internal/config"
)

func TestBootstrapWritableDirsDedupsParents(t *testing.T) {
	cfg := config.Config{
		TempRoot:    filepath.Join("/var/lib/wisp", "demo"),
		RuntimeRoot: filepath.Join("/var/lib/wisp-runtime", "demo"),
		AdminRoot:   filepath.Join("/run", "envd-demo"),
	}

	got := bootstrapWritableDirs(cfg)
	want := []string{"/run", "/var/lib/wisp", "/var/lib/wisp-runtime"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("bootstrapWritableDirs=%v want %v", got, want)
	}
}
