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
)

type Options struct {
	Resolver *hostroute.Resolver
	Sites    sitemeta.Lookup
	Origin   origin.Fetcher
	Logger   *log.Logger
}

type SiteHandler struct {
	resolver *hostroute.Resolver
	sites    sitemeta.Lookup
	origin   origin.Fetcher
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
		logger:   logger,
	}
}

func (h *SiteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeErrorPage(w, http.StatusMethodNotAllowed, "方法不被支持")
		return
	}

	siteID, host, ok := h.resolver.Resolve(r.Host)
	if !ok {
		// 自定义域名绑定尚未实现，未命中根域的 Host 一律拒绝，
		// 绝不回落到任何默认站点——回落会让错配的域名把流量导到别人的站点。
		h.logger.Printf("unresolved host: %q", host)
		writeErrorPage(w, http.StatusNotFound, "站点不存在")
		return
	}

	site, err := h.sites.BySiteID(r.Context(), siteID)
	if errors.Is(err, sitemeta.ErrNotFound) {
		writeErrorPage(w, http.StatusNotFound, "站点不存在")
		return
	}
	if err != nil {
		h.logger.Printf("lookup site %q failed: %v", siteID, err)
		writeErrorPage(w, http.StatusBadGateway, "站点暂时无法访问")
		return
	}

	switch site.Status {
	case sitemeta.StatusActive:
	case sitemeta.StatusSuspended:
		writeErrorPage(w, http.StatusForbidden, "站点已下线")
		return
	case sitemeta.StatusBlocked:
		writeErrorPage(w, http.StatusForbidden, "站点因违反服务条款已被停用")
		return
	default:
		// creating / deleting / deleted 以及未知状态都当作不可访问。
		writeErrorPage(w, http.StatusNotFound, "站点不存在")
		return
	}

	candidates, ok := objectkey.Candidates(siteID, r.URL.Path)
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
			writeErrorPage(w, http.StatusBadGateway, "站点暂时无法访问")
			return
		}
		h.writeObject(w, r, key, obj)
		return
	}

	h.writeSiteNotFound(w, r, siteID)
}

// writeSiteNotFound 优先使用站点自带的 404.html，回落到网关内置错误页。
func (h *SiteHandler) writeSiteNotFound(w http.ResponseWriter, r *http.Request, siteID string) {
	obj, err := h.origin.Get(r.Context(), objectkey.NotFoundKey(siteID))
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
// 重新发布是原地覆盖 current/ 目录，文件名不变，所以 HTML 必须每次回源校验，
// 否则用户发布后看到的仍是旧页面。其他静态资源给一个短缓存，兼顾带宽和新鲜度。
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
