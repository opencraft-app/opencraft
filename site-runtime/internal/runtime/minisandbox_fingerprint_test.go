package runtime

import (
	"fmt"
	"strings"
	"testing"
)

func TestNativePackageFingerprintCoversExecutionMetadata(t *testing.T) {
	p, err := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, err := minisandboxPackageFingerprint(p)
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint != p.PackageID {
		t.Fatal("generated execution marker is not the canonical package fingerprint")
	}
	for _, field := range []string{"compatibility_date", "durable_objects", "main_module"} {
		t.Run(field, func(t *testing.T) {
			changed := p
			switch field {
			case "compatibility_date":
				changed.CompatibilityDate = "2026-05-01"
			case "durable_objects":
				changed.DurableObjects = map[string]string{"SITE": "AnotherSite"}
			case "main_module":
				changed.MainModule = "another.js"
				changed.Modules = map[string]string{"another.js": p.Modules["main.js"]}
			}
			other, err := minisandboxPackageFingerprint(changed)
			if err != nil {
				t.Fatal(err)
			}
			if other == fingerprint {
				t.Fatalf("execution metadata %s was omitted from fingerprint", field)
			}
		})
	}
}
func TestNativePackageFingerprintExcludesOnlyItsOwnMarker(t *testing.T) {
	p, err := buildMinisandboxPackage(map[string]Bundle{"wr-one": fixture()})
	if err != nil {
		t.Fatal(err)
	}
	bare := p
	bare.Modules = map[string]string{}
	prefix := fmt.Sprintf("const platformPackageID = %q;\n", p.PackageID)
	for name, source := range p.Modules {
		bare.Modules[name] = source
	}
	bare.Modules[p.MainModule] = strings.TrimPrefix(bare.Modules[p.MainModule], prefix)
	fingerprint, err := minisandboxPackageFingerprint(bare)
	if err != nil || fingerprint != p.PackageID {
		t.Fatalf("marker exclusion mismatch: %s %v", fingerprint, err)
	}
	bare.Modules["backend-"+fixture().SHA256+".js"] += "\n// execution-source change"
	fingerprint, err = minisandboxPackageFingerprint(bare)
	if err != nil || fingerprint == p.PackageID {
		t.Fatalf("backend source omitted from fingerprint: %s %v", fingerprint, err)
	}
}
