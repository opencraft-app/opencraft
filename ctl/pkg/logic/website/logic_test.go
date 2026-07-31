package website

import (
	"testing"
)

// validSHA256 is the SHA-256 hash of empty string, 64 hex chars
const validSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestValidateArtifactHash(t *testing.T) {
	tests := []struct {
		name string
		hash string
		want bool
	}{
		{"empty", "", false},
		{"valid_sha256_prefix", "sha256:" + validSHA256, true},
		{"valid_hex", validSHA256, true},
		{"too_short", "abc123", false},
		{"invalid_hex_64", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", false},
		{"wrong_length", "abc123", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateArtifactHash(tt.hash)
			if got != tt.want {
				t.Errorf("validateArtifactHash(%q) = %v, want %v", tt.hash, got, tt.want)
			}
		})
	}
}

func TestValidateFilePath(t *testing.T) {
	tests := []struct {
		name string
		path string
		want bool
	}{
		{"normal", "index.html", true},
		{"nested", "css/style.css", true},
		{"deep_nested", "assets/images/logo.png", true},
		{"path_traversal", "../etc/passwd", false},
		{"absolute", "/etc/passwd", false},
		{"windows_abs", "\\windows\\system32", false},
		{"dotdot_slash", "../../secret", false},
		{"valid_dot", "./index.html", true},
		{"empty", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := validateFilePath(tt.path)
			if got != tt.want {
				t.Errorf("validateFilePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestGenerateUploadURL_NoConfig(t *testing.T) {
	url := generateUploadURL("ws-test", "wr-test")
	if url != "" {
		t.Errorf("expected empty URL when COS not configured, got %s", url)
	}
}
