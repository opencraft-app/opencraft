package meshharness

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type FederationTarget struct {
	Cluster string
	URL     string
}

type FederatedCell struct {
	Cluster     string
	Cell        string
	HeartbeatAt time.Time
}

type FederationEvaluator struct {
	Client    *http.Client
	Freshness time.Duration
	Now       func() time.Time
}

// Scrape evaluates only the identity and freshness contract needed by the
// MeshHarness. The configured target identity always replaces an untrusted
// cluster label from the spoke response.
func (e FederationEvaluator) Scrape(ctx context.Context, targets []FederationTarget) (map[string]FederatedCell, error) {
	client := e.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	now := time.Now().UTC()
	if e.Now != nil {
		now = e.Now().UTC()
	}
	freshness := e.Freshness
	if freshness <= 0 {
		freshness = 2 * time.Minute
	}
	cells := make(map[string]FederatedCell)
	for _, target := range targets {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(target.URL, "/")+"/federate", nil)
		if err != nil {
			return nil, err
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("scrape %s: %w", target.Cluster, err)
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("scrape %s: HTTP %d", target.Cluster, response.StatusCode)
		}
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "rivet_cell_heartbeat_timestamp_seconds{") {
				continue
			}
			cell, value, ok := parseHeartbeat(line)
			if !ok {
				response.Body.Close()
				return nil, fmt.Errorf("scrape %s: malformed heartbeat", target.Cluster)
			}
			heartbeat := time.Unix(int64(value), 0).UTC()
			if heartbeat.After(now) || now.Sub(heartbeat) > freshness {
				continue
			}
			if previous, exists := cells[cell]; exists && previous.Cluster != target.Cluster {
				response.Body.Close()
				return nil, fmt.Errorf("Cell %s appeared in both %s and %s", cell, previous.Cluster, target.Cluster)
			}
			cells[cell] = FederatedCell{Cluster: target.Cluster, Cell: cell, HeartbeatAt: heartbeat}
		}
		err = scanner.Err()
		response.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("scrape %s: %w", target.Cluster, err)
		}
	}
	return cells, nil
}

func parseHeartbeat(line string) (string, float64, bool) {
	closeBrace := strings.IndexByte(line, '}')
	if closeBrace < 0 {
		return "", 0, false
	}
	labels := line[len("rivet_cell_heartbeat_timestamp_seconds{"):closeBrace]
	cell := ""
	for _, label := range strings.Split(labels, ",") {
		parts := strings.SplitN(strings.TrimSpace(label), "=", 2)
		if len(parts) == 2 && parts[0] == "cell" {
			cell = strings.Trim(parts[1], `"`)
		}
	}
	fields := strings.Fields(line[closeBrace+1:])
	if len(fields) == 0 {
		return "", 0, false
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	return cell, value, err == nil && cell != ""
}
