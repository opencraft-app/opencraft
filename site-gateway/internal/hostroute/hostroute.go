// Package hostroute 把请求的 Host 解析成站点标识。
//
// 站点身份必须由服务端从 Host 推导，绝不能来自请求参数或请求体——这是整个多租户
// 隔离模型的基石。前端无法决定自己是哪个站点，也就无法越界访问其他站点的对象前缀。
package hostroute

import (
	"strings"
)

// Resolver 按配置的根域把 Host 解析为 siteID。
//
// 根域是配置项而非常量：测试环境和正式环境用不同的域，正式根域后续还会更换，
// 硬编码会让换域名变成改代码 + 重新发版。
type Resolver struct {
	rootDomains []string
}

// New 构造 Resolver。根域会被归一化（小写、去掉首尾的点），空项忽略。
func New(rootDomains []string) *Resolver {
	normalized := make([]string, 0, len(rootDomains))
	for _, domain := range rootDomains {
		domain = strings.Trim(strings.ToLower(strings.TrimSpace(domain)), ".")
		if domain == "" {
			continue
		}
		normalized = append(normalized, domain)
	}
	return &Resolver{rootDomains: normalized}
}

// Resolve 返回子域名模式下的 siteID。
//
// 未命中任何根域时返回归一化后的 host 和 false，由调用方去查自定义域名绑定表。
// 归一化后的 host 是绑定表的查询键，所以即使解析失败也要返回它。
func (r *Resolver) Resolve(host string) (siteID string, normalizedHost string, ok bool) {
	normalizedHost = normalizeHost(host)
	if normalizedHost == "" {
		return "", "", false
	}
	for _, root := range r.rootDomains {
		suffix := "." + root
		if !strings.HasSuffix(normalizedHost, suffix) {
			continue
		}
		label := strings.TrimSuffix(normalizedHost, suffix)
		// 只接受单标签。`a.b.example.com` 这种多级子域不属于站点命名空间，
		// 放行会让 Host 到 siteID 的映射出现歧义。
		if label == "" || strings.Contains(label, ".") {
			continue
		}
		if !isValidDNSLabel(label) {
			continue
		}
		return label, normalizedHost, true
	}
	return "", normalizedHost, false
}

// normalizeHost 去掉端口、大小写和末尾的根点，得到可用于比较和查表的 host。
func normalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if host == "" {
		return ""
	}
	// IPv6 字面量形如 [::1]:8080，冒号不能直接当端口分隔符。
	if strings.HasPrefix(host, "[") {
		if end := strings.LastIndex(host, "]"); end >= 0 {
			host = host[:end+1]
		}
	} else if idx := strings.LastIndex(host, ":"); idx >= 0 {
		host = host[:idx]
	}
	return strings.Trim(strings.ToLower(host), ".")
}

// isValidDNSLabel 校验单个 DNS 标签。
//
// siteID 会被直接拼进 COS 对象 key，所以这里同时承担了「防止奇怪字符进入存储路径」
// 的职责，不能只依赖后续的站点查询兜底。
func isValidDNSLabel(label string) bool {
	if len(label) == 0 || len(label) > 63 {
		return false
	}
	if label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for i := 0; i < len(label); i++ {
		c := label[i]
		switch {
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '-':
		default:
			return false
		}
	}
	return true
}
