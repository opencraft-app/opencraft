// Package httpapi 提供站点网关的 HTTP 入口。
package httpapi

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/objectkey"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
	"git.woa.com/wisp/mono/site-gateway/internal/usage"
)

type Options struct {
	Resolver *hostroute.Resolver
	Sites    sitemeta.Lookup
	Origin   origin.Fetcher
	// Usage 为 nil 表示不计量，请求路径不需要额外判空。
	Usage  *usage.Meter
	Logger *log.Logger
}

type SiteHandler struct {
	resolver *hostroute.Resolver
	sites    sitemeta.Lookup
	origin   origin.Fetcher
	usage    *usage.Meter
	logger   *log.Logger
}

func NewSiteHandler(opts Options) *SiteHandler {
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &SiteHandler{
		resolver: opts.Resolver,
		sites:    opts.Sites,
		origin:   opts.Origin,
		usage:    opts.Usage,
		logger:   logger,
	}
}

// ServeHTTP 把站点路径空间整体交给静态回源。
//
// 网关不再保留任何命名空间：站点是纯静态托管，没有需要与页面同源的服务端接口，
// 保留前缀只会白白占用用户的路径。所有路径一视同仁地走候选 key 回源，命不中就 404。
func (h *SiteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.serveStatic(w, r)
}

func (h *SiteHandler) serveStatic(w http.ResponseWriter, r *http.Request) {
	// 站点是只读的：网关自身不具备写 COS 的能力，写方法在入口就拒掉。
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeErrorPage(w, http.StatusMethodNotAllowed, "方法不被支持")
		return
	}

	siteID, publishedPrefix, ok := h.resolveSite(w, r)
	if !ok {
		return
	}

	// 计量从这里才开始，刻意放在站点解析和门禁之后：
	//   - 未命中根域、站点不存在、已下线、已超额的请求都在上面就返回了，
	//     因此随机子域名扫描不会在计数器里创建条目（内存有界的关键前提）；
	//   - 那些响应也不该算进用户的流量——它们一个字节的 COS 回源都没产生。
	counted := &countingWriter{ResponseWriter: w}
	w = counted
	defer func() { h.usage.Record(siteID, counted.written) }()

	candidates, ok := objectkey.CandidatesForPrefix(publishedPrefix, r.URL.Path)
	if !ok {
		writeErrorPage(w, http.StatusBadRequest, "非法请求路径")
		return
	}

	for _, key := range candidates {
		obj, err := h.origin.Get(r.Context(), key)
		if errors.Is(err, origin.ErrNotFound) {
			continue
		}
		if err != nil {
			h.logger.Printf("fetch %q failed: %v", key, err)
			writeErrorPage(w, http.StatusBadGateway, msgUpstream)
			return
		}
		h.writeObject(w, r, key, obj)
		return
	}

	h.writeSiteNotFound(w, r, publishedPrefix)
}

// countingWriter 统计实际写给客户端的字节数。
//
// 为什么不用 Content-Length：HEAD 和 304 都不发 body，中途断开的传输也只发出了
// 一部分，而这三种情况在真实浏览里都不少见。按响应头的声明值计数会系统性高估。
// 包一层 Writer 是唯一能同时覆盖这三种情况的做法——它统计的就是真的写出去的量。
type countingWriter struct {
	http.ResponseWriter
	written int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.written += int64(n)
	return n, err
}

// resolveSite 完成 Host 推导和站点状态门禁。
//
// siteID 只能由 Host 推导，不接受任何请求参数：这是多租户隔离的唯一入口，
// 一旦允许请求影响 siteID，站点之间的边界就没了。
func (h *SiteHandler) resolveSite(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	siteID, host, ok := h.resolver.Resolve(r.Host)
	if !ok {
		// 自定义域名绑定尚未实现，未命中根域的 Host 一律拒绝，
		// 绝不回落到任何默认站点——回落会让错配的域名把流量导到别人的站点。
		h.logger.Printf("unresolved host: %q", host)
		writeErrorPage(w, http.StatusNotFound, msgSiteNotFound)
		return "", "", false
	}

	site, err := h.sites.BySiteID(r.Context(), siteID)
	if errors.Is(err, sitemeta.ErrNotFound) {
		writeErrorPage(w, http.StatusNotFound, msgSiteNotFound)
		return "", "", false
	}
	if err != nil {
		h.logger.Printf("lookup site %q failed: %v", siteID, err)
		writeErrorPage(w, http.StatusBadGateway, msgUpstream)
		return "", "", false
	}

	switch site.Status {
	case sitemeta.StatusActive:
		// 超额拦在这一层，和 suspended/blocked 用的是同一处门禁。
		//
		// 放在网关而不是别处有两个好处：拦得彻底（用户拿不到任何绕过的路径），
		// 以及超额之后不再产生新的 COS 回源流量——真正花钱的那部分被止住了。
		// 已发布的内容一个字节都不删，下个月自然恢复。
		if site.TrafficExhausted() {
			writeErrorPage(w, http.StatusForbidden, msgTrafficExhausted)
			return "", "", false
		}
		publishedPrefix, ok := objectkey.ValidatePublishedPrefix(siteID, site.CloudPath)
		if !ok {
			h.logger.Printf("invalid cloud_path for site %q", siteID)
			writeErrorPage(w, http.StatusBadGateway, msgUpstream)
			return "", "", false
		}
		return siteID, publishedPrefix, true
	case sitemeta.StatusSuspended:
		writeErrorPage(w, http.StatusForbidden, msgSiteSuspended)
	case sitemeta.StatusBlocked:
		writeErrorPage(w, http.StatusForbidden, msgSiteBlocked)
	default:
		// creating / deleting / deleted 以及未知状态都当作不可访问。
		writeErrorPage(w, http.StatusNotFound, msgSiteNotFound)
	}
	return "", "", false
}

const (
	msgSiteNotFound  = "站点不存在"
	msgSiteSuspended = "站点已下线"
	msgSiteBlocked   = "站点因违反服务条款已被停用"
	// msgTrafficExhausted 与下线页同一套版式：对访问者来说两者是同一类事情
	// （站点暂时不可访问），没有必要为此多一套样式。
	msgTrafficExhausted = "本月流量已用尽"
	msgUpstream         = "站点暂时无法访问"
)

// writeSiteNotFound 优先使用站点自带的 404.html，回落到网关内置错误页。
func (h *SiteHandler) writeSiteNotFound(w http.ResponseWriter, r *http.Request, publishedPrefix string) {
	obj, err := h.origin.Get(r.Context(), objectkey.NotFoundKeyForPrefix(publishedPrefix))
	if err != nil {
		writeErrorPage(w, http.StatusNotFound, "页面不存在")
		return
	}
	defer obj.Body.Close()

	w.Header().Set("Content-Type", contentTypeOrDefault(obj.ContentType, "text/html; charset=utf-8"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusNotFound)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, obj.Body)
	}
}

func (h *SiteHandler) writeObject(w http.ResponseWriter, r *http.Request, key string, obj *origin.Object) {
	defer obj.Body.Close()

	header := w.Header()
	header.Set("Content-Type", contentTypeOrDefault(obj.ContentType, "application/octet-stream"))
	header.Set("Cache-Control", cacheControlFor(key, obj.CacheControl))
	if obj.ETag != "" {
		header.Set("ETag", obj.ETag)
	}
	if obj.LastModified != "" {
		header.Set("Last-Modified", obj.LastModified)
	}
	// 站点内容由用户生成，禁止浏览器按嗅探结果改变 Content-Type，
	// 避免把上传的文本当脚本执行。
	header.Set("X-Content-Type-Options", "nosniff")

	if obj.ETag != "" && etagMatches(r.Header.Get("If-None-Match"), obj.ETag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if obj.ContentLength >= 0 {
		header.Set("Content-Length", strconv.FormatInt(obj.ContentLength, 10))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, obj.Body); err != nil {
		h.logger.Printf("stream %q interrupted: %v", key, err)
	}
}

// cacheControlFor 决定缓存策略。
//
// 重新发布会原子切换到新的不可变 release 前缀，但固定站点 URL 下的 HTML 内容会变化，
// 所以 HTML 必须每次回源校验。其他静态资源给一个短缓存，兼顾带宽和新鲜度。
func cacheControlFor(key string, upstream string) string {
	if upstream != "" {
		return upstream
	}
	if strings.HasSuffix(key, ".html") || strings.HasSuffix(key, ".htm") {
		return "no-cache"
	}
	return "public, max-age=300"
}

func contentTypeOrDefault(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func etagMatches(ifNoneMatch string, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	if strings.TrimSpace(ifNoneMatch) == "*" {
		return true
	}
	for _, candidate := range strings.Split(ifNoneMatch, ",") {
		candidate = strings.TrimSpace(candidate)
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == etag {
			return true
		}
	}
	return false
}

func writeErrorPage(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"+
		"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"+
		"<title>"+message+"</title></head>"+
		"<body style=\"font-family:system-ui,sans-serif;display:flex;align-items:center;"+
		"justify-content:center;height:100vh;margin:0;color:#334155;background:#f8fafc\">"+
		"<main style=\"text-align:center\"><h1 style=\"font-size:20px;font-weight:600\">"+message+"</h1></main>"+
		"</body></html>")
}
