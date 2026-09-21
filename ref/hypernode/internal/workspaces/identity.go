package workspaces

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// PrincipalHomeSegment is the single canonical host-side directory name for
// one SSH principal. Keeping this in the workspace domain prevents the runc
// attachment resolver and the policy host from deriving different paths.
func PrincipalHomeSegment(username string) string {
	clean := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || strings.ContainsRune("._-", r) {
			return r
		}
		return '-'
	}, username)
	clean = strings.Trim(clean, "-")
	if clean == "" {
		clean = "user"
	}
	sum := sha256.Sum256([]byte(username))
	return fmt.Sprintf("%s-%s", clean, hex.EncodeToString(sum[:])[:10])
}

// PrincipalAttachmentResolver returns only the selected principal's
// attachment capability. It must never return UsersRoot itself.
func PrincipalAttachmentResolver(usersRoot string) (AttachmentSourceResolver, error) {
	root, err := filepath.Abs(usersRoot)
	if err != nil || root != filepath.Clean(usersRoot) {
		return nil, fmt.Errorf("users root must be an absolute clean path: %q", usersRoot)
	}
	return func(principal Principal) (string, error) {
		if principal.Username == "" {
			return "", fmt.Errorf("principal username is required")
		}
		return filepath.Join(root, PrincipalHomeSegment(principal.Username), ".codex", "attachments"), nil
	}, nil
}

// PrincipalHomeResolver returns only the selected principal's durable home.
// The caller can bind that one directory into an isolated runtime without
// ever exposing the users root or another principal's credentials.
func PrincipalHomeResolver(usersRoot string) (AttachmentSourceResolver, error) {
	root, err := filepath.Abs(usersRoot)
	if err != nil || root != filepath.Clean(usersRoot) {
		return nil, fmt.Errorf("users root must be an absolute clean path: %q", usersRoot)
	}
	return func(principal Principal) (string, error) {
		if principal.Username == "" {
			return "", fmt.Errorf("principal username is required")
		}
		return filepath.Join(root, PrincipalHomeSegment(principal.Username)), nil
	}, nil
}
