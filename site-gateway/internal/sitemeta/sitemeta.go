// Package sitemeta 从 ctl 拉取站点元信息，并做短 TTL 缓存。
//
// 每个静态资源请求都要知道站点是否存在、是否已下线，直接回源 ctl 会让 ctl
// 承受站点的全部流量。缓存 TTL 很短，站点状态变更（下线/封禁）最迟在一个
// TTL 后生效，这个延迟对下线场景是可接受的。
package sitemeta

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// 站点状态，与 ctl/pkg/model/website 的常量保持一致。
const (
	StatusCreating  = "creating"
	StatusActive    = "active"
	StatusSuspended = "suspended"
	StatusBlocked   = "blocked"
	StatusDeleting  = "deleting"
	StatusDeleted   = "deleted"
)

// ErrNotFound 表示站点不存在。与「查询失败」区分开：前者返回 404，后者返回 502。
var ErrNotFound = errors.New("site not found")

type Site struct {
	SiteID string `json:"site_id"`
	Status string `json:"status"`
}

// Lookup 是服务端查询站点的能力，抽成接口便于测试替换。
type Lookup interface {
	BySiteID(ctx context.Context, siteID string) (*Site, error)
}

type Options struct {
	BaseURL       string
	InternalToken string
	HTTPClient    *http.Client
	PositiveTTL   time.Duration
	NegativeTTL   time.Duration
}

type Client struct {
	baseURL     string
	token       string
	httpClient  *http.Client
	positiveTTL time.Duration
	negativeTTL time.Duration

	mu    sync.RWMutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	site      *Site
	notFound  bool
	expiresAt time.Time
}

func NewClient(opts Options) *Client {
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second}
	}
	if opts.PositiveTTL <= 0 {
		opts.PositiveTTL = 30 * time.Second
	}
	// 不存在的站点缓存更短：新建站点要尽快可访问，而枚举不存在的子域名
	// 本来就应该被限流挡住，不需要靠长缓存扛。
	if opts.NegativeTTL <= 0 {
		opts.NegativeTTL = 5 * time.Second
	}
	return &Client{
		baseURL:     strings.TrimRight(opts.BaseURL, "/"),
		token:       opts.InternalToken,
		httpClient:  client,
		positiveTTL: opts.PositiveTTL,
		negativeTTL: opts.NegativeTTL,
		cache:       make(map[string]cacheEntry),
	}
}

func (c *Client) BySiteID(ctx context.Context, siteID string) (*Site, error) {
	if entry, ok := c.lookupCache(siteID); ok {
		if entry.notFound {
			return nil, ErrNotFound
		}
		return entry.site, nil
	}

	site, err := c.fetch(ctx, siteID)
	if errors.Is(err, ErrNotFound) {
		c.storeCache(siteID, cacheEntry{notFound: true, expiresAt: time.Now().Add(c.negativeTTL)})
		return nil, ErrNotFound
	}
	if err != nil {
		// 查询失败不写缓存：ctl 短暂抖动不应该被固化成一段时间内的持续失败。
		return nil, err
	}
	c.storeCache(siteID, cacheEntry{site: site, expiresAt: time.Now().Add(c.positiveTTL)})
	return site, nil
}

func (c *Client) fetch(ctx context.Context, siteID string) (*Site, error) {
	endpoint := c.baseURL + "/internal/ctl/websites/sites/" + url.PathEscape(siteID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	// ctl 的内部接口用 X-Internal-Token 做常量时间比对，不是 Bearer。
	if c.token != "" {
		req.Header.Set("X-Internal-Token", c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query site: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	default:
		return nil, fmt.Errorf("query site: unexpected status %d", resp.StatusCode)
	}

	// ctl 的响应统一包在 {"code","message","data"} 信封里。
	var envelope struct {
		Data Site `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("decode site: %w", err)
	}
	if envelope.Data.SiteID == "" {
		return nil, fmt.Errorf("query site: response missing site_id")
	}
	return &envelope.Data, nil
}

func (c *Client) lookupCache(siteID string) (cacheEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.cache[siteID]
	if !ok || time.Now().After(entry.expiresAt) {
		return cacheEntry{}, false
	}
	return entry, true
}

func (c *Client) storeCache(siteID string, entry cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[siteID] = entry
}
