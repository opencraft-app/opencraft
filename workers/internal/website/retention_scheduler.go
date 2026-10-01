package website

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"
)

func retentionSweepInterval() (time.Duration, error) {
	raw := os.Getenv("WEBSITE_RETENTION_SWEEP_INTERVAL")
	if raw == "" {
		return 0, nil
	}
	interval, err := time.ParseDuration(raw)
	if err != nil || interval < time.Minute || interval > 24*time.Hour {
		return 0, fmt.Errorf("invalid WEBSITE_RETENTION_SWEEP_INTERVAL (1m..24h)")
	}
	return interval, nil
}

func (d *Deployer) sweepRetention(ctx context.Context, cursor string) (string, error) {
	req, err := d.newInternalRequest(http.MethodPost, d.ctlBaseURL+"/internal/ctl/websites/retention/sweep?cursor="+url.QueryEscape(cursor), nil)
	if err != nil {
		return cursor, err
	}
	req = req.WithContext(ctx)
	response, err := d.httpClient.Do(req)
	if err != nil {
		return cursor, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return cursor, fmt.Errorf("retention sweep status %d", response.StatusCode)
	}
	var result struct {
		Data *struct {
			NextCursor string `json:"next_cursor"`
			Scanned    int    `json:"scanned"`
			Scheduled  int    `json:"scheduled"`
			Deferred   int    `json:"deferred"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(&result); err != nil {
		return cursor, fmt.Errorf("invalid retention response")
	}
	if result.Data == nil || result.Data.Scanned < 0 || result.Data.Scanned > 20 || len(result.Data.NextCursor) > 128 || (result.Data.NextCursor != "" && result.Data.NextCursor <= cursor) {
		return cursor, fmt.Errorf("invalid retention cursor")
	}
	if result.Data.Deferred > 0 {
		log.Printf("website retention deferred sites=%d", result.Data.Deferred)
	}
	return result.Data.NextCursor, nil
}

// StartRetentionScheduler is opt-in. Each tick scans one bounded page. Multiple
// replicas are safe because CTL reservations serialize on the site row; failures
// preserve the cursor for retry, and a completed cycle resets it to the start.
func (d *Deployer) StartRetentionScheduler(ctx context.Context) (<-chan struct{}, error) {
	interval, err := retentionSweepInterval()
	if err != nil {
		return nil, err
	}
	done := make(chan struct{})
	if interval == 0 {
		close(done)
		return done, nil
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		cursor := ""
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				next, err := d.sweepRetention(ctx, cursor)
				if err != nil {
					if ctx.Err() == nil {
						log.Printf("website retention sweep failed: %v", err)
					}
					continue
				}
				cursor = next
			}
		}
	}()
	return done, nil
}
