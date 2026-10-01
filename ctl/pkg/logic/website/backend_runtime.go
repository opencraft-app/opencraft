package website

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Empty allowlist is disabled. This gate is not a substitute for release checks:
// every activation also verifies its immutable runtime revision independently.
func backendEnabledFor(userID string) bool {
	if _, _, err := backendRuntimeConfig(); err != nil {
		return false
	}
	for _, id := range strings.Split(os.Getenv("WEBSITE_BACKEND_BETA_USERS"), ",") {
		if strings.TrimSpace(id) == userID && userID != "" {
			return true
		}
	}
	return false
}
func backendRuntimeConfig() (string, string, error) {
	base := strings.TrimRight(os.Getenv("WEBSITE_RUNTIME_BASE_URL"), "/")
	token := os.Getenv("WEBSITE_RUNTIME_DEPLOY_TOKEN")
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || token == "" {
		return "", "", fmt.Errorf("website runtime not configured")
	}
	return base, token, nil
}
func verifyBackendReady(siteID, releaseID, digest string) error {
	base, token, err := backendRuntimeConfig()
	if err != nil {
		return err
	}
	req, err := http.NewRequest("GET", base+"/v1/sites/"+url.PathEscape(siteID)+"/releases/"+url.PathEscape(releaseID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("backend readiness unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("backend not ready")
	}
	var status struct {
		SHA256 string `json:"sha256"`
		Status string `json:"status"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(nil, response.Body, 4096))
	if err := decoder.Decode(&status); err != nil || status.Status != "ready" || status.SHA256 != digest {
		return fmt.Errorf("backend revision mismatch")
	}
	return nil
}
