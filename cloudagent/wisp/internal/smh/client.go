package smh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	libraryID     string
	accessDomain  string
	librarySecret string
	httpClient    *http.Client
}

type TokenRequest struct {
	SpaceID       string
	UserID        string
	ClientID      string
	Grant         []string
	PeriodSeconds int
}

type TokenResponse struct {
	AccessToken string `json:"accessToken"`
	ExpiresIn   int    `json:"expiresIn"`
}

type CreateSpaceRequest struct {
	PublicRead   *bool  `json:"isPublicRead,omitempty"`
	SpaceTag     string `json:"spaceTag,omitempty"`
	MultiAlbum   *bool  `json:"isMultiAlbum,omitempty"`
	AllowPhoto   *bool  `json:"allowPhoto,omitempty"`
	AllowVideo   *bool  `json:"allowVideo,omitempty"`
	RecognizeSFW *bool  `json:"recognizeSensitiveContent,omitempty"`
}

type CreateSpaceResponse struct {
	SpaceID string `json:"spaceId"`
}

func NewClient(accessDomain, libraryID, librarySecret string, httpClient *http.Client) (*Client, error) {
	if strings.TrimSpace(accessDomain) == "" {
		return nil, fmt.Errorf("smh access domain is required")
	}
	if strings.TrimSpace(libraryID) == "" {
		return nil, fmt.Errorf("smh library id is required")
	}
	if strings.TrimSpace(librarySecret) == "" {
		return nil, fmt.Errorf("smh library secret is required")
	}
	parsed, err := url.Parse(strings.TrimSpace(accessDomain))
	if err != nil {
		return nil, fmt.Errorf("parse smh access domain: %w", err)
	}
	host := parsed.Hostname()
	if parsed.Scheme != "https" && host != "127.0.0.1" && host != "localhost" {
		return nil, fmt.Errorf("smh access domain must use https")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		libraryID:     strings.TrimSpace(libraryID),
		accessDomain:  strings.TrimRight(parsed.String(), "/"),
		librarySecret: strings.TrimSpace(librarySecret),
		httpClient:    httpClient,
	}, nil
}

func (c *Client) IssueToken(ctx context.Context, req TokenRequest) (TokenResponse, error) {
	q := url.Values{}
	q.Set("library_id", c.libraryID)
	q.Set("library_secret", c.librarySecret)
	if strings.TrimSpace(req.SpaceID) != "" {
		q.Set("space_id", strings.TrimSpace(req.SpaceID))
	}
	if strings.TrimSpace(req.UserID) != "" {
		q.Set("user_id", strings.TrimSpace(req.UserID))
	}
	if strings.TrimSpace(req.ClientID) != "" {
		q.Set("client_id", strings.TrimSpace(req.ClientID))
	}
	if req.PeriodSeconds > 0 {
		q.Set("period", fmt.Sprintf("%d", req.PeriodSeconds))
	}
	if len(req.Grant) > 0 {
		q.Set("grant", strings.Join(req.Grant, ","))
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.accessDomain+"/api/v1/token?"+q.Encode(), nil)
	if err != nil {
		return TokenResponse{}, err
	}
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return TokenResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return TokenResponse{}, fmt.Errorf("smh issue token http %d", resp.StatusCode)
	}
	var out TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return TokenResponse{}, err
	}
	if strings.TrimSpace(out.AccessToken) == "" {
		return TokenResponse{}, fmt.Errorf("smh issue token returned empty accessToken")
	}
	return out, nil
}

func (c *Client) CreateSpace(ctx context.Context, accessToken string, req CreateSpaceRequest) (CreateSpaceResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return CreateSpaceResponse{}, err
	}
	httpReq, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		fmt.Sprintf("%s/api/v1/space/%s?access_token=%s", c.accessDomain, url.PathEscape(c.libraryID), url.QueryEscape(strings.TrimSpace(accessToken))),
		bytes.NewReader(body),
	)
	if err != nil {
		return CreateSpaceResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return CreateSpaceResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return CreateSpaceResponse{}, fmt.Errorf("smh create space http %d", resp.StatusCode)
	}
	var out CreateSpaceResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return CreateSpaceResponse{}, err
	}
	if strings.TrimSpace(out.SpaceID) == "" {
		return CreateSpaceResponse{}, fmt.Errorf("smh create space returned empty spaceId")
	}
	return out, nil
}
