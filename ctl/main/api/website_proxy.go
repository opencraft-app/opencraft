package main

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"

	"ctl/pkg/model/website"
)

// handleSiteProxy 处理 /s/{siteId}/* 的公开访问流量代理
func (h *websiteHandler) handleSiteProxy(w http.ResponseWriter, r *http.Request) {
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
		w.Write([]byte("<html><body><h1>站点已暂停</h1></body></html>"))
		return
	}

	if site.CloudPath == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("<html><body><h1>站点建设中</h1></body></html>"))
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

	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.Director = func(req *http.Request) {
		req.URL = targetURL
		req.Host = targetURL.Host
	}
	proxy.ServeHTTP(w, r)
}
