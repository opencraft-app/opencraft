// Package usage 在进程内按站点聚合出向流量，并按固定周期批量上报给 ctl。
//
// # 这不是计费凭据
//
// 计数完全在内存里：进程崩溃会丢掉最后一个尚未上报的窗口（最多一个上报间隔的量），
// 多副本各自聚合各自上报、由 ctl 侧累加，因此同一时刻的读数还带着副本间的偏斜。
// 这个数字的用途只有两个——给用户看的近似用量，以及超额时把站点闸掉。
// **任何形式的扣费都不能以它为依据**，需要精确账目请走 COS 自身的用量账单。
//
// # 为什么不引入 Redis
//
// 站点网关目前零外部状态依赖，这是它最重要的性质：站点的可用性不取决于任何
// 其他组件是否健在。为了让流量计数精确一点而加一个 Redis，等于给静态托管
// 引入一个新的可用性单点和一次额外 RTT，换来的只是一个本来就承认有误差的数字。
//
// # 为什么批量上报而不是逐请求
//
// 站点流量的量级远大于业务接口：一个页面一次访问就是几十个对象请求。逐请求上报
// 会让 ctl 承受站点的全部 QPS，而这个数字只需要分钟级精度。所以按站点在内存里
// 攒够一个窗口，一个请求带上该窗口内所有有流量的站点。
package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
)

// defaultMaxSites 是内存里同时保留的站点计数条目上界。
//
// 需要一个硬上界而不是任由 map 增长：网关是公网直连的，内存无界就是一个
// 拿请求就能触发的 OOM 入口。真正让这个上界几乎不可能被打满的，是调用方
// **只在站点解析成功之后**才计量——随机子域名扫描根本创建不了条目。
// 这一条比上界本身更关键，删掉上界只是变慢，删掉那个前置条件是直接可被攻击。
const defaultMaxSites = 20000

// Sample 是一个上报窗口内某个站点的流量增量。
type Sample struct {
	SiteID       string `json:"site_id"`
	TrafficBytes int64  `json:"traffic_bytes"`
	RequestCount int64  `json:"request_count"`
}

type counter struct {
	trafficBytes int64
	requestCount int64
}

// Meter 是按站点聚合的内存计数器。
//
// 所有方法都可以在 nil 接收者上调用，表示「未启用计量」：这样调用方不需要
// 在请求路径上到处判空。
type Meter struct {
	maxSites int

	mu      sync.Mutex
	entries map[string]*counter
	// dropped 记录因为达到上界而被丢弃的样本数，只用于告警观测。
	dropped int64
}

func NewMeter(maxSites int) *Meter {
	if maxSites <= 0 {
		maxSites = defaultMaxSites
	}
	return &Meter{
		maxSites: maxSites,
		entries:  make(map[string]*counter),
	}
}

// Record 累加一次请求的出向字节数。
//
// bytes 必须是**实际写给客户端的响应体字节数**，不是 Content-Length 头：
// HEAD 和 304 都没有 body，中途断开的传输也只发出了一部分。用响应头的声明值
// 会系统性高估，尤其是 304——条件请求在正常浏览下占比不低。
//
// bytes 为 0 时仍然记一次请求：请求数本身是有意义的观测量（304 命中率、
// 是否在被高频扫描），而且丢掉零字节请求会让 request_count 失真。
func (m *Meter) Record(siteID string, bytes int64) {
	if m == nil || siteID == "" {
		return
	}
	if bytes < 0 {
		bytes = 0
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	entry, ok := m.entries[siteID]
	if !ok {
		if len(m.entries) >= m.maxSites {
			// 丢样本而不是淘汰已有条目：被淘汰的那个站点会连带丢掉整个窗口
			// 已经攒下的量，损失比丢当前这一次请求大得多。
			m.dropped++
			return
		}
		entry = &counter{}
		m.entries[siteID] = entry
	}
	entry.trafficBytes += bytes
	entry.requestCount++
}

// Drain 取出并清空当前窗口的全部计数。
//
// 取出即清零，由调用方负责把它交付出去；交付失败时用 MergeBack 放回来。
// 返回值按 site_id 排序，让上报请求体在同样的输入下稳定可比（便于抓包比对）。
func (m *Meter) Drain() []Sample {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	entries := m.entries
	m.entries = make(map[string]*counter)
	m.mu.Unlock()

	if len(entries) == 0 {
		return nil
	}
	samples := make([]Sample, 0, len(entries))
	for siteID, entry := range entries {
		samples = append(samples, Sample{
			SiteID:       siteID,
			TrafficBytes: entry.trafficBytes,
			RequestCount: entry.requestCount,
		})
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i].SiteID < samples[j].SiteID })
	return samples
}

// MergeBack 把一批交付失败的样本并回内存，等下一个窗口重试。
//
// 这样 ctl 短暂不可用只会推迟入账，不会丢数据。代价是「服务端已入账但响应丢失」
// 这种模糊失败会导致重复计数——上报是纯增量、天然不幂等，而在
// 「宁可偶尔多算一点」和「ctl 抖一下就丢一整个窗口」之间，前者是更合适的取舍，
// 因为这个数字本来就不是计费凭据。
func (m *Meter) MergeBack(samples []Sample) {
	if m == nil || len(samples) == 0 {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, sample := range samples {
		entry, ok := m.entries[sample.SiteID]
		if !ok {
			if len(m.entries) >= m.maxSites {
				m.dropped++
				continue
			}
			entry = &counter{}
			m.entries[sample.SiteID] = entry
		}
		entry.trafficBytes += sample.TrafficBytes
		entry.requestCount += sample.RequestCount
	}
}

// Size 返回当前保留的站点条目数，供测试和容量观测使用。
func (m *Meter) Size() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.entries)
}

// Dropped 返回因达到上界而丢弃的样本数。
func (m *Meter) Dropped() int64 {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.dropped
}

// Sink 是上报的目的地，抽成接口便于测试替换。
type Sink interface {
	Report(ctx context.Context, windowID string, samples []Sample) error
}

// Reporter 驱动「每隔 interval 把内存里的增量交付给 ctl」这件事。
type Reporter struct {
	meter    *Meter
	sink     Sink
	interval time.Duration
	timeout  time.Duration
	logger   *log.Logger
}

type ReporterOptions struct {
	Meter    *Meter
	Sink     Sink
	Interval time.Duration
	// Timeout 是单次上报的超时。必须明显小于 Interval，否则一次卡住的上报
	// 会把下一个窗口的 tick 一起拖掉。
	Timeout time.Duration
	Logger  *log.Logger
}

func NewReporter(opts ReporterOptions) *Reporter {
	if opts.Interval <= 0 {
		opts.Interval = time.Minute
	}
	if opts.Timeout <= 0 || opts.Timeout >= opts.Interval {
		opts.Timeout = opts.Interval / 3
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Reporter{
		meter:    opts.Meter,
		sink:     opts.Sink,
		interval: opts.Interval,
		timeout:  opts.Timeout,
		logger:   logger,
	}
}

// Run 阻塞运行上报循环，直到 ctx 结束。
//
// 退出前做最后一次 Flush：优雅退出（滚动发布、缩容）在正常运维中远比崩溃频繁，
// 每次发布都丢掉一个窗口的话，发布本身就成了一种系统性的少计。
func (r *Reporter) Run(ctx context.Context) {
	if r == nil || r.meter == nil || r.sink == nil {
		return
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// 用独立的 context：此时 ctx 已经取消，拿它去发请求必然立刻失败。
			flushCtx, cancel := context.WithTimeout(context.Background(), r.timeout)
			r.Flush(flushCtx)
			cancel()
			return
		case <-ticker.C:
			flushCtx, cancel := context.WithTimeout(ctx, r.timeout)
			r.Flush(flushCtx)
			cancel()
		}
	}
}

// Flush 交付一个窗口的增量。失败时把增量并回内存，等下一个窗口重试。
func (r *Reporter) Flush(ctx context.Context) {
	if r == nil || r.meter == nil || r.sink == nil {
		return
	}
	samples := r.meter.Drain()
	if len(samples) == 0 {
		return
	}
	windowID := strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := r.sink.Report(ctx, windowID, samples); err != nil {
		r.meter.MergeBack(samples)
		r.logger.Printf("usage report failed (window %s, %d sites), merged back for retry: %v",
			windowID, len(samples), err)
		return
	}
	if dropped := r.meter.Dropped(); dropped > 0 {
		r.logger.Printf("usage meter dropped %d samples so far: site count exceeded the in-memory bound", dropped)
	}
}

// HTTPSink 把增量 POST 到 ctl 的内部上报接口。
type HTTPSink struct {
	endpoint string
	token    string
	client   *http.Client
}

func NewHTTPSink(baseURL, internalToken string, client *http.Client) *HTTPSink {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &HTTPSink{
		endpoint: baseURL + "/internal/ctl/websites/usage",
		token:    internalToken,
		client:   client,
	}
}

func (s *HTTPSink) Report(ctx context.Context, windowID string, samples []Sample) error {
	payload, err := json.Marshal(map[string]interface{}{
		"window_id": windowID,
		"reports":   samples,
	})
	if err != nil {
		return fmt.Errorf("encode usage report: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build usage report request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	// 与站点元信息查询同一把内部 token，ctl 侧做常量时间比对。
	if s.token != "" {
		req.Header.Set("X-Internal-Token", s.token)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("post usage report: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("post usage report: unexpected status %d", resp.StatusCode)
	}
	return nil
}
