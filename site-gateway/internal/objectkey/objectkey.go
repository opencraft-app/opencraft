// Package objectkey 把站点 ID 和请求路径映射到 COS 对象 key。
package objectkey

import (
	"path"
	"strings"
)

// PublishedPrefix 是站点对外服务的稳定目录。
//
// 必须与 workers/internal/website/deployer.go 的 sitePublishedPrefix 保持一致：
// deployer 往这里写，网关从这里读，两边对不上站点就是 404。
func PublishedPrefix(siteID string) string {
	return "sites/" + siteID + "/current/"
}

// DataPrefix 是站点数据面文档的前缀。
func DataPrefix(siteID string) string {
	return "sites/" + siteID + "/data/"
}

// NotFoundKey 是站点自带的 404 页面。站点没有提供时由网关返回内置错误页。
func NotFoundKey(siteID string) string {
	return PublishedPrefix(siteID) + "404.html"
}

// Candidates 返回按优先级排列的候选 key，调用方依次尝试直到命中。
//
// 返回 false 表示路径非法（含控制字符），应当直接拒绝而不是继续尝试。
//
// 目录索引补全的两种情况：
//   - 以 / 结尾（/about/）直接补 index.html
//   - 无扩展名（/about）先试文件本身，再试 /about/index.html
//
// 不做 SPA 的 index.html 全局兜底：建站 Skill 已禁止 History 模式路由，
// 全局兜底只会把真正的 404 伪装成 200，掩盖发布产物缺文件的问题。
func Candidates(siteID string, requestPath string) ([]string, bool) {
	if strings.ContainsAny(requestPath, "\x00\r\n") {
		return nil, false
	}

	trailingSlash := strings.HasSuffix(requestPath, "/")
	// path.Clean 会把 ../ 归并掉，越过根目录的部分被截断为 /，
	// 因此清理后的路径不可能逃出站点前缀。
	cleaned := path.Clean("/" + requestPath)

	prefix := PublishedPrefix(siteID)
	if cleaned == "/" {
		return []string{prefix + "index.html"}, true
	}

	relative := strings.TrimPrefix(cleaned, "/")
	if trailingSlash {
		return []string{prefix + relative + "/index.html"}, true
	}
	if path.Ext(relative) == "" {
		return []string{
			prefix + relative,
			prefix + relative + "/index.html",
		}, true
	}
	return []string{prefix + relative}, true
}
