package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"

	"ctl/pkg/model/website"
)

// countingResponseWriter 包装 http.ResponseWriter 以统计响应字节数
type countingResponseWriter struct {
	http.ResponseWriter
	bytesWritten int64
}

func (w *countingResponseWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.bytesWritten += int64(n)
	return n, err
}

// handleSiteProxy 处理 /s/{siteId}/* 的公开访问流量代理
func (h *websiteHandler) handleSiteProxy(w http.ResponseWriter, r *http.Request) {
	// CORS 预检
	if r.Method == http.MethodOptions {
		setCORSHeaders(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	setCORSHeaders(w)

	path := strings.TrimPrefix(r.URL.Path, "/s/")
	if path == "" {
		http.NotFound(w, r)
		return
	}
	parts := strings.SplitN(path, "/", 2)
	siteID := parts[0]
	remainingPath := ""
	if len(parts) > 1 {
		remainingPath = parts[1]
	}

	siteDao := website.NewSiteDao()
	site, err := siteDao.GetBySiteID(siteID)
	if err != nil || site == nil {
		http.NotFound(w, r)
		return
	}

	if site.Status != website.SiteStatusActive {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte("<html><body><h1>站点已暂停</h1><p>站点因套餐到期等原因暂停，续费后自动恢复。</p></body></html>"))
		return
	}

	if site.CloudPath == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("<html><body><h1>站点建设中</h1><p>站点尚未完成首次部署，请稍后再试。</p></body></html>"))
		return
	}

	if remainingPath == "" {
		remainingPath = "index.html"
	}

	envID := os.Getenv("CLOUDBASE_STATIC_ENV_ID")
	if envID == "" {
		http.Error(w, "site backend not configured", http.StatusInternalServerError)
		return
	}

	targetURL, err := url.Parse("https://" + envID + ".tcloudbaseapp.com/" + site.CloudPath + remainingPath)
	if err != nil {
		http.Error(w, "invalid site path", http.StatusInternalServerError)
		return
	}

	// 用计数 ResponseWriter 包装，统计流量
	cw := &countingResponseWriter{ResponseWriter: w}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.Director = func(req *http.Request) {
		req.URL = targetURL
		req.Host = targetURL.Host
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		// 设置CORS头到代理响应
		resp.Header.Set("Access-Control-Allow-Origin", "*")
		resp.Header.Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
		resp.Header.Set("Access-Control-Allow-Headers", "Content-Type")
		return nil
	}

	proxy.ServeHTTP(cw, r)

	// 异步记录流量（不阻塞请求）
	if cw.bytesWritten > 0 && site.UserID != "" {
		go func() {
			_ = h.logic.RecordTraffic(siteID, site.UserID, cw.bytesWritten)
		}()
	}
}

// setCORSHeaders 设置CORS响应头
func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}
