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

const (
	AccessModeOwnerOnly = "owner_only"
	AccessModeShareCode = "share_code"
)

// NormalizeAccessMode 让空值和未知值安全降级为仅所有者访问。
func NormalizeAccessMode(mode string) string {
	if mode == AccessModeShareCode {
		return AccessModeShareCode
	}
	return AccessModeOwnerOnly
}

// ErrNotFound 表示站点不存在。与「查询失败」区分开：前者返回 404，后者返回 502。
var ErrNotFound = errors.New("site not found")

type Site struct {
	SiteID          string     `json:"site_id"`
	UserID          string     `json:"user_id"`
	Status          string     `json:"status"`
	CloudPath       string     `json:"cloud_path"`
	AccessMode      string     `json:"access_mode"`
	ShareGeneration string     `json:"share_generation"`
	ShareExpiresAt  *time.Time `json:"share_expires_at"`
	// MonthlyTrafficBytes 是该站点所属套餐的月流量额度，0 表示不限额。
	//
	// 额度和已用量跟着状态一起回来，而不是另开一次查询：这个接口已经有 30 秒
	// TTL 缓存，多带两个数字是零成本；新增一次回源则会让站点的全部流量再打一遍 ctl。
	MonthlyTrafficBytes int64 `json:"monthly_traffic_bytes"`
	// UsedTrafficBytes 是所属用户当月已用流量（跨该用户的全部站点）。
	UsedTrafficBytes int64 `json:"used_traffic_bytes"`
}

// ShareAccessActiveAt 只接受同时具备 generation 且绝对到期时间仍在未来的分享状态。
// 即使 CTL 元数据仍在 30 秒缓存中，过期时间一到也不会继续放行旧 Cookie。
func (s *Site) ShareAccessActiveAt(now time.Time) bool {
	return s != nil && NormalizeAccessMode(s.AccessMode) == AccessModeShareCode &&
		strings.TrimSpace(s.ShareGeneration) != "" && s.ShareExpiresAt != nil && s.ShareExpiresAt.After(now)
}

// TrafficExhausted 判断该站点是否应因当月流量用尽而停止服务。
//
// 额度为 0（未配置 / ctl 查不到）时一律放行：因为一次配额查询失败就把用户站点
// 整体 403，比让流量多跑一会儿糟糕得多。超额拦截是滥用防护，不是精确门禁。
//
// 精度必须承认：网关每分钟才上报一次用量，站点元信息还有 30 秒缓存，所以从真正
// 超额到实际拦住有约 90 秒延迟；多副本还各自计数，实际拦截点会略高于额度。
// **它是滥用防护的闸，不是精确计量。**
func (s *Site) TrafficExhausted() bool {
	if s == nil || s.MonthlyTrafficBytes <= 0 {
		return false
	}
	return s.UsedTrafficBytes >= s.MonthlyTrafficBytes
}

// Lookup 是服务端查询站点的能力，抽成接口便于测试替换。
type Lookup interface {
	BySiteID(ctx context.Context, siteID string) (*Site, error)
}

// FreshLookup 用于认证等必须绕过缓存的关键校验。
type FreshLookup interface {
	BySiteIDFresh(ctx context.Context, siteID string) (*Site, error)
}

// DomainLookup 在 Host 未命中根域时查询自定义域名→site_id。
//
// nil 表示自定义域名功能未启用——site-gateway 在 Options 里把它设为 nil，
// 行为与功能上线前完全一致（未命中根域的 Host 一律 404）。
type DomainLookup interface {
	SiteIDByDomain(ctx context.Context, domain string) (string, error)
}

type Options struct {
	BaseURL       string
	InternalToken string
	HTTPClient    *http.Client
	PositiveTTL   time.Duration
	NegativeTTL   time.Duration
	// MaxEntries 是缓存条目的硬上界，防止内存无界增长。
	MaxEntries int
}

// defaultMaxEntries 是缓存条目的默认上界。
//
// 必须有上界：条目是按 Host 推导出的 siteID 建的，其中包含**查不到的站点**
// （负缓存）。随机子域名扫描能凭空塞进任意多个 key，而过期只是让条目不再命中、
// 并不会把它从 map 里去掉——没有上界的话这是一个拿请求就能触发的内存增长入口。
const defaultMaxEntries = 20000

// sweepInterval 是两次主动清理之间的最小间隔。
//
// 清理挂在请求路径上而不是后台 goroutine：省掉一套启停和优雅退出的生命周期管理，
// 而清理本身是一次 map 遍历，在这个量级下开销可以忽略。
const sweepInterval = time.Minute

type Client struct {
	baseURL     string
	token       string
	httpClient  *http.Client
	positiveTTL time.Duration
	negativeTTL time.Duration
	maxEntries  int

	mu              sync.Mutex
	cache           map[string]cacheEntry
	lastSweep       time.Time
	domainCache     map[string]cacheEntry
	domainLastSweep time.Time
}

type cacheEntry struct {
	site      *Site
	siteID    string
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
	if opts.MaxEntries <= 0 {
		opts.MaxEntries = defaultMaxEntries
	}
	return &Client{
		baseURL:         strings.TrimRight(opts.BaseURL, "/"),
		token:           opts.InternalToken,
		httpClient:      client,
		positiveTTL:     opts.PositiveTTL,
		negativeTTL:     opts.NegativeTTL,
		maxEntries:      opts.MaxEntries,
		cache:           make(map[string]cacheEntry),
		lastSweep:       time.Now(),
		domainCache:     make(map[string]cacheEntry),
		domainLastSweep: time.Now(),
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

func (c *Client) BySiteIDFresh(ctx context.Context, siteID string) (*Site, error) {
	site, err := c.fetch(ctx, siteID)
	if errors.Is(err, ErrNotFound) {
		c.storeCache(siteID, cacheEntry{notFound: true, expiresAt: time.Now().Add(c.negativeTTL)})
		return nil, ErrNotFound
	}
	if err != nil {
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
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.cache[siteID]
	if !ok || time.Now().After(entry.expiresAt) {
		return cacheEntry{}, false
	}
	return entry, true
}

func (c *Client) storeCache(siteID string, entry cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	c.sweepIfDue(now)
	if _, exists := c.cache[siteID]; !exists {
		c.makeRoom(now)
	}
	c.cache[siteID] = entry
}

func (c *Client) sweepIfDue(now time.Time) {
	if now.Sub(c.lastSweep) < sweepInterval {
		return
	}
	c.lastSweep = now
	c.sweep(now)
}

func (c *Client) sweep(now time.Time) {
	for siteID, entry := range c.cache {
		if now.After(entry.expiresAt) {
			delete(c.cache, siteID)
		}
	}
}

// makeRoom 在插入新条目之前腾出位置。
//
// 先清过期条目；实在腾不出来（同时活跃的站点数真的超过上界）就丢掉一个已过期
// 判据之外的条目。淘汰缓存条目是完全安全的降级：下一次请求会重新回源 ctl，
// 最坏结果只是多一次内部查询，绝不会影响判定的正确性。
func (c *Client) makeRoom(now time.Time) {
	if len(c.cache) < c.maxEntries {
		return
	}
	c.sweep(now)
	for siteID := range c.cache {
		if len(c.cache) < c.maxEntries {
			return
		}
		delete(c.cache, siteID)
	}
}

// CacheSize 返回当前缓存条目数，供测试和容量观测使用。
func (c *Client) CacheSize() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.cache)
}

// SiteIDByDomain 查询自定义域名绑定的 site_id。
//
// 缓存策略与 BySiteID 一致：正结果缓存 positiveTTL，未找到缓存 negativeTTL。
// 查询失败（ctl 抖动）不写缓存。缓存与 BySiteID 的缓存独立——键空间不同
// （一个按 siteID，一个按 domain），不会互相驱逐。
// normalizeDomain 去端口、小写、去尾点。与 hostroute.normalizeHost 同一规则，
// 确保缓存键和 URL 路径都用归一化后的域名。
func normalizeDomain(domain string) string {
	domain = strings.TrimSpace(domain)
	if domain == "" {
		return ""
	}
	if !strings.HasPrefix(domain, "[") {
		if idx := strings.LastIndex(domain, ":"); idx >= 0 {
			domain = domain[:idx]
		}
	}
	return strings.Trim(strings.ToLower(domain), ".")
}

func (c *Client) SiteIDByDomain(ctx context.Context, domain string) (string, error) {
	domain = normalizeDomain(domain)
	if domain == "" {
		return "", ErrNotFound
	}
	if entry, ok := c.lookupDomainCache(domain); ok {
		if entry.notFound {
			return "", ErrNotFound
		}
		return entry.siteID, nil
	}

	siteID, err := c.fetchDomain(ctx, domain)
	if errors.Is(err, ErrNotFound) {
		c.storeDomainCache(domain, cacheEntry{notFound: true, expiresAt: time.Now().Add(c.negativeTTL)})
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	c.storeDomainCache(domain, cacheEntry{siteID: siteID, expiresAt: time.Now().Add(c.positiveTTL)})
	return siteID, nil
}

// fetchDomain 调用 ctl 的内部接口查 domain→site_id。
func (c *Client) fetchDomain(ctx context.Context, domain string) (string, error) {
	endpoint := c.baseURL + "/internal/ctl/websites/domains/" + url.PathEscape(domain)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("build domain request: %w", err)
	}
	if c.token != "" {
		req.Header.Set("X-Internal-Token", c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("query domain: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return "", ErrNotFound
	default:
		return "", fmt.Errorf("query domain: unexpected status %d", resp.StatusCode)
	}

	var envelope struct {
		Data struct {
			SiteID string `json:"site_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return "", fmt.Errorf("decode domain response: %w", err)
	}
	if envelope.Data.SiteID == "" {
		return "", fmt.Errorf("query domain: response missing site_id")
	}
	return envelope.Data.SiteID, nil
}

// domainCacheEntry 复用 cacheEntry 的结构，多一个 siteID 字段。
// BySiteID 的 cacheEntry 里 site 是 *Site 指针，这里只需要 site_id 字符串。
// 为了复用 notFound / expiresAt 字段而不拆两套结构，在 cacheEntry 上加 siteID。

func (c *Client) lookupDomainCache(domain string) (cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.domainCache[domain]
	if !ok || time.Now().After(entry.expiresAt) {
		return cacheEntry{}, false
	}
	return entry, true
}

func (c *Client) storeDomainCache(domain string, entry cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	c.sweepDomainIfDue(now)
	if _, exists := c.domainCache[domain]; !exists {
		c.makeDomainRoom(now)
	}
	c.domainCache[domain] = entry
}

func (c *Client) sweepDomainIfDue(now time.Time) {
	if now.Sub(c.domainLastSweep) < sweepInterval {
		return
	}
	c.domainLastSweep = now
	for domain, entry := range c.domainCache {
		if now.After(entry.expiresAt) {
			delete(c.domainCache, domain)
		}
	}
}

func (c *Client) makeDomainRoom(now time.Time) {
	if len(c.domainCache) < c.maxEntries {
		return
	}
	c.sweepDomainIfDue(now)
	for domain := range c.domainCache {
		if len(c.domainCache) < c.maxEntries {
			return
		}
		delete(c.domainCache, domain)
	}
}
