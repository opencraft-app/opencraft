package cleanroom

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

var credentialPatterns = []struct {
	name    string
	pattern *regexp.Regexp
}{
	{
		name:    "private key",
		pattern: regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`),
	},
	{
		name:    "JWT",
		pattern: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b`),
	},
	{
		name:    "AWS access key",
		pattern: regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
	},
	{
		name:    "GitHub token",
		pattern: regexp.MustCompile(`\bgh[opusr]_[A-Za-z0-9]{30,}\b`),
	},
	{
		name:    "Raft credential",
		pattern: regexp.MustCompile(`\b(?:sk|sap)_[A-Za-z0-9_-]{24,}\b`),
	},
}

func TestGoBuildBoundaryDoesNotReferenceRecoveredEvidence(t *testing.T) {
	t.Parallel()

	projectRoot := cleanRoomProjectRoot(t)
	forbidden := []string{
		"restored" + "/",
		"first-party" + "/",
		"restored" + `\`,
		"first-party" + `\`,
	}
	walkTextFiles(t, projectRoot, func(path string, data []byte) {
		if filepath.Ext(path) != ".go" {
			return
		}
		for _, marker := range forbidden {
			if strings.Contains(string(data), marker) {
				t.Errorf("%s references clean-room-excluded evidence path %q", path, marker)
			}
		}
	})
}

func TestTextArtifactsContainNoCredentialShapedSecrets(t *testing.T) {
	t.Parallel()

	projectRoot := cleanRoomProjectRoot(t)
	walkTextFiles(t, projectRoot, func(path string, data []byte) {
		for _, candidate := range credentialPatterns {
			matches := candidate.pattern.FindAll(data, -1)
			for _, match := range matches {
				normalized := strings.ToLower(string(match))
				if strings.Contains(normalized, "fixture") || strings.Contains(normalized, "test") {
					continue
				}
				t.Errorf("%s contains a %s-shaped value", path, candidate.name)
			}
		}
	})
}

func TestCanonicalTreeContainsNoObsoleteNodeBridgeArtifacts(t *testing.T) {
	t.Parallel()

	projectRoot := cleanRoomProjectRoot(t)
	legacyRelease := filepath.Join(projectRoot, "bin", "vela-darwin-arm64")
	for _, name := range []string{
		"bundle.cjs",
		"sea-prep.blob",
		"sea-config.generated.json",
		"manifest.json",
		"NODE-LICENSE",
		"raft-computer-im-bridge",
	} {
		path := filepath.Join(legacyRelease, name)
		if _, err := os.Lstat(path); err == nil {
			t.Errorf("obsolete Node/IM Bridge artifact remains: %s", path)
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
}

func TestGoSourceHasNoLongExactLinesCopiedFromRecoveredBundles(t *testing.T) {
	t.Parallel()

	projectRoot := cleanRoomProjectRoot(t)
	evidenceRoot := filepath.Join(filepath.Dir(projectRoot), "restored")
	if _, err := os.Stat(evidenceRoot); os.IsNotExist(err) {
		t.Skip("restored clean-room evidence is intentionally not shipped in the canonical source repository")
	} else if err != nil {
		t.Fatal(err)
	}
	evidenceLines := make(map[string]struct{})
	err := filepath.WalkDir(evidenceRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".js" {
			return nil
		}
		return scanNormalizedLines(path, func(line string) {
			if len(line) >= 140 {
				evidenceLines[line] = struct{}{}
			}
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(evidenceLines) == 0 {
		t.Fatal("clean-room evidence line index is empty")
	}

	err = filepath.WalkDir(projectRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "bin" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "guard_test.go") {
			return nil
		}
		lineNumber := 0
		return scanNormalizedLines(path, func(line string) {
			lineNumber++
			if len(line) < 140 {
				return
			}
			if _, copied := evidenceLines[line]; copied {
				t.Errorf("%s:%d has a long exact line matching recovered evidence", path, lineNumber)
			}
		})
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeCorePackagesKeepNarrowArchitectureBoundaries(t *testing.T) {
	t.Parallel()

	projectRoot := cleanRoomProjectRoot(t)
	testCases := []struct {
		path      string
		forbidden []string
	}{
		{
			path: filepath.Join(projectRoot, "internal", "runtimeactor", "actor.go"),
			forbidden: []string{
				"/internal/codex",
				"/internal/hermes",
				"/internal/runtimecatalog",
				`"turn/start"`,
				`"turn/steer"`,
				`"session/prompt"`,
				`"session/cancel"`,
			},
		},
		{
			path: filepath.Join(projectRoot, "internal", "runtimeactor", "coordinator.go"),
			forbidden: []string{
				"/internal/codex",
				"/internal/hermes",
				"/internal/runtimecatalog",
			},
		},
		{
			path: filepath.Join(projectRoot, "internal", "vela", "runtimehost", "adapter.go"),
			forbidden: []string{
				"/internal/codex",
				"/internal/hermes",
				"codex.New(",
				"hermes.New(",
			},
		},
	}
	for _, testCase := range testCases {
		data, err := os.ReadFile(testCase.path)
		if err != nil {
			t.Fatal(err)
		}
		for _, marker := range testCase.forbidden {
			if strings.Contains(string(data), marker) {
				t.Errorf("%s contains forbidden architecture marker %q", testCase.path, marker)
			}
		}
	}
}

func cleanRoomProjectRoot(t *testing.T) string {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve clean-room test location")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", ".."))
}

func walkTextFiles(t *testing.T, root string, inspect func(string, []byte)) {
	t.Helper()
	textExtensions := map[string]struct{}{
		".go":   {},
		".json": {},
		".md":   {},
		".sh":   {},
	}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "bin" {
				return filepath.SkipDir
			}
			return nil
		}
		if _, ok := textExtensions[filepath.Ext(path)]; !ok {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		inspect(path, data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func scanNormalizedLines(path string, inspect func(string)) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.Join(strings.Fields(scanner.Text()), " ")
		if line != "" {
			inspect(line)
		}
	}
	return scanner.Err()
}
