package shardmanager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type HTTPControlClient struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

func (c HTTPControlClient) ObserveShard(ctx context.Context, projection ShardProjection) error {
	body, err := json.Marshal(projection)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+"/api/internal/shard-manager/shards", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.Token)
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	return fmt.Errorf("observe shard %s status=%d body=%s", projection.ID, response.StatusCode, strings.TrimSpace(string(raw)))
}
