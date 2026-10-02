package website

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// backendBundle separates platform-private code from every publicly served file.
func backendBundle(files []*zip.File, op Operation) (string, error) {
	var code string
	seen := map[string]bool{}
	for _, file := range files {
		if file.FileInfo().IsDir() {
			continue
		}
		if seen[file.Name] {
			return "", fmt.Errorf("duplicate archive path")
		}
		seen[file.Name] = true
		if file.Mode()&0111 != 0 || file.Mode().Type() != 0 {
			return "", fmt.Errorf("unsupported archive entry")
		}
		if !strings.HasPrefix(file.Name, "__backend/") {
			continue
		}
		if op.Kind != "fullstack" || file.Name != "__backend/app.mjs" || file.UncompressedSize64 > 1<<20 {
			return "", fmt.Errorf("invalid private backend artifact")
		}
		reader, err := file.Open()
		if err != nil {
			return "", err
		}
		body, readErr := io.ReadAll(io.LimitReader(reader, (1<<20)+1))
		closeErr := reader.Close()
		if readErr != nil || closeErr != nil || len(body) > 1<<20 {
			return "", fmt.Errorf("invalid backend code")
		}
		code = string(body)
	}
	if op.Kind == "fullstack" {
		sum := sha256Hex([]byte(code))
		if code == "" || sum != op.BackendSHA256 {
			return "", fmt.Errorf("backend SHA-256 mismatch")
		}
	}
	return code, nil
}
func (d *Deployer) runtimeRequest(method, path string, body any, out any) error {
	u, err := url.Parse(d.runtimeURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || d.runtimeToken == "" {
		return fmt.Errorf("website runtime unavailable")
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 110*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, d.runtimeURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+d.runtimeToken)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 110 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("runtime request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("runtime status %d", response.StatusCode)
	}
	if out != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(out); err != nil {
			return fmt.Errorf("invalid runtime response")
		}
	}
	return nil
}
func (d *Deployer) deployBackend(op Operation, code string) error {
	var result struct {
		SHA256 string `json:"sha256"`
		Status string `json:"status"`
	}
	err := d.runtimeRequest("PUT", "/v1/sites/"+url.PathEscape(op.SiteID)+"/releases/"+url.PathEscape(op.ReleaseID), map[string]string{"code": code, "sha256": op.BackendSHA256}, &result)
	if err != nil {
		return err
	}
	if result.SHA256 != op.BackendSHA256 || result.Status != "ready" {
		return fmt.Errorf("backend readiness mismatch")
	}
	return nil
}
func (d *Deployer) deleteBackend(op Operation) error {
	return d.runtimeRequest("DELETE", "/v1/sites/"+url.PathEscape(op.SiteID)+"/releases/"+url.PathEscape(op.ReleaseID), nil, nil)
}
func (d *Deployer) backendStorage(site string) (int64, error) {
	if d.runtimeURL == "" {
		return 0, nil
	}
	var result struct {
		Storage int64 `json:"storage_bytes"`
	}
	err := d.runtimeRequest("GET", "/v1/sites/"+url.PathEscape(site), nil, &result)
	if err != nil {
		return 0, err
	}
	if result.Storage < 0 {
		return 0, fmt.Errorf("invalid runtime storage")
	}
	return result.Storage, nil
}

func sha256Hex(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func (d *Deployer) executeRollback(op Operation) error {
	if d.siteCos == nil {
		return d.failOperation(op, "site storage unavailable")
	}
	prefix := siteReleasePrefix(op.SiteID, op.ReleaseID)
	if _, err := d.siteCos.client.Object.Head(context.Background(), prefix+"index.html", nil); err != nil {
		return d.failOperation(op, "rollback static revision is no longer retained")
	}
	if op.Kind == "fullstack" {
		var ready struct {
			Status string `json:"status"`
			SHA256 string `json:"sha256"`
		}
		err := d.runtimeRequest("GET", "/v1/sites/"+url.PathEscape(op.SiteID)+"/releases/"+url.PathEscape(op.ReleaseID), nil, &ready)
		if err != nil || ready.Status != "ready" || ready.SHA256 != op.BackendSHA256 {
			return d.failOperation(op, "rollback backend revision unavailable")
		}
	}
	return d.completeOperation(op, prefix, d.getSitePublicURL(op))
}
