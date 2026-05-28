package wispcloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type SMHClientConfig struct {
	AccessDomain  string
	LibraryID     string
	LibrarySecret string
	HTTPClient    *http.Client
}

type SMHClient struct {
	accessDomain  string
	libraryID     string
	librarySecret string
	httpClient    *http.Client
}

type SMHSpace struct {
	SpaceID     string
	AccessToken string
}

func NewSMHClient(cfg SMHClientConfig) (*SMHClient, error) {
	accessDomain := strings.TrimRight(strings.TrimSpace(cfg.AccessDomain), "/")
	if accessDomain == "" {
		accessDomain = strings.TrimRight(strings.TrimSpace(firstEnv("SMH_ACCESS_DOMAIN")), "/")
	}
	libraryID := strings.TrimSpace(cfg.LibraryID)
	if libraryID == "" {
		libraryID = strings.TrimSpace(firstEnv("SMH_LIBRARY_ID"))
	}
	librarySecret := strings.TrimSpace(cfg.LibrarySecret)
	if librarySecret == "" {
		librarySecret = strings.TrimSpace(firstEnv("SMH_LIBRARY_SECRET"))
	}
	if accessDomain == "" || libraryID == "" || librarySecret == "" {
		return nil, errors.New("SMH_ACCESS_DOMAIN, SMH_LIBRARY_ID, and SMH_LIBRARY_SECRET are required")
	}
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &SMHClient{
		accessDomain:  accessDomain,
		libraryID:     libraryID,
		librarySecret: librarySecret,
		httpClient:    httpClient,
	}, nil
}

func (c *SMHClient) AccessDomain() string {
	return c.accessDomain
}

func (c *SMHClient) LibraryID() string {
	return c.libraryID
}

func (c *SMHClient) ProvisionSpace(ctx context.Context) (SMHSpace, error) {
	createToken, err := c.IssueToken(ctx, "", "create_space,admin")
	if err != nil {
		return SMHSpace{}, err
	}

	body, _ := json.Marshal(map[string]string{"spaceTag": fmt.Sprintf("cloudagent-wisp-%d", time.Now().UnixNano())})
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", c.accessDomain, url.PathEscape(c.libraryID), url.QueryEscape(createToken)),
		bytes.NewReader(body),
	)
	if err != nil {
		return SMHSpace{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return SMHSpace{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return SMHSpace{}, fmt.Errorf("SMH create space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		SpaceID string `json:"spaceId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return SMHSpace{}, err
	}
	if strings.TrimSpace(out.SpaceID) == "" {
		return SMHSpace{}, errors.New("SMH create space returned empty spaceId")
	}
	accessToken, err := c.IssueToken(ctx, out.SpaceID, "admin")
	if err != nil {
		return SMHSpace{}, err
	}
	return SMHSpace{SpaceID: out.SpaceID, AccessToken: accessToken}, nil
}

func (c *SMHClient) OpenSpace(ctx context.Context, spaceID string) (SMHSpace, error) {
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		return SMHSpace{}, errors.New("SMH space id is required")
	}
	accessToken, err := c.IssueToken(ctx, spaceID, "admin")
	if err != nil {
		return SMHSpace{}, err
	}
	return SMHSpace{SpaceID: spaceID, AccessToken: accessToken}, nil
}

func (c *SMHClient) IssueToken(ctx context.Context, spaceID, grant string) (string, error) {
	q := url.Values{}
	q.Set("library_id", c.libraryID)
	q.Set("library_secret", c.librarySecret)
	if strings.TrimSpace(spaceID) != "" {
		q.Set("space_id", spaceID)
	}
	q.Set("grant", grant)
	q.Set("period", "3600")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.accessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return "", err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", fmt.Errorf("SMH issue token http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return "", errors.New("SMH issue token returned empty accessToken")
	}
	return out.AccessToken, nil
}

func (c *SMHClient) DeleteSpace(ctx context.Context, spaceID string) error {
	if strings.TrimSpace(spaceID) == "" {
		return nil
	}
	token, err := c.IssueToken(ctx, "", "admin,delete_space")
	if err != nil {
		return err
	}
	spaceToken, err := c.IssueToken(ctx, spaceID, "admin")
	if err != nil {
		return err
	}
	if err := c.deleteRootEntries(ctx, spaceID, spaceToken); err != nil {
		return err
	}
	q := url.Values{}
	q.Set("access_token", token)
	q.Set("force", "1")
	endpoint := fmt.Sprintf("%s/api/v1/space/%s/%s?%s", c.accessDomain, url.PathEscape(c.libraryID), url.PathEscape(spaceID), q.Encode())
	var lastErr error
	for attempt := 1; attempt <= 6; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
		if err != nil {
			return err
		}
		resp, err := c.httpClient.Do(req)
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
			return nil
		}
		lastErr = fmt.Errorf("SMH delete space http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		if resp.StatusCode != http.StatusConflict || !strings.Contains(string(body), "SpaceNotEmpty") {
			return lastErr
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	return lastErr
}

func (c *SMHClient) deleteRootEntries(ctx context.Context, spaceID, accessToken string) error {
	q := url.Values{}
	q.Set("access_token", accessToken)
	q.Set("permanent", "1")
	q.Set("page_size", "200")
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fmt.Sprintf("%s/api/v1/directory/%s/%s?%s", c.accessDomain, url.PathEscape(c.libraryID), url.PathEscape(spaceID), q.Encode()),
		nil,
	)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("SMH list root http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		Contents []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"contents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return err
	}
	for _, entry := range out.Contents {
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			continue
		}
		kind := "file"
		if entry.Type == "dir" || entry.Type == "directory" {
			kind = "directory"
		}
		if err := c.deleteEntry(ctx, spaceID, accessToken, kind, name); err != nil {
			return err
		}
	}
	return nil
}

func (c *SMHClient) deleteEntry(ctx context.Context, spaceID, accessToken, kind, name string) error {
	q := url.Values{}
	q.Set("access_token", accessToken)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodDelete,
		fmt.Sprintf("%s/api/v1/%s/%s/%s/%s?%s", c.accessDomain, kind, url.PathEscape(c.libraryID), url.PathEscape(spaceID), url.PathEscape(name), q.Encode()),
		nil,
	)
	if err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("SMH delete %s %q http %d: %s", kind, name, resp.StatusCode, strings.TrimSpace(string(body)))
}
