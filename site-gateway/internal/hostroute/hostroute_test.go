package hostroute

import "testing"

func TestResolveSubdomain(t *testing.T) {
	r := New([]string{"sites.lightclaw.tech", "SITES.EXAMPLE.COM."})

	cases := []struct {
		name   string
		host   string
		siteID string
	}{
		{"普通子域名", "ws-a1b2c3d4e5f60718.sites.lightclaw.tech", "ws-a1b2c3d4e5f60718"},
		{"带端口", "ws-a1b2c3d4e5f60718.sites.lightclaw.tech:8080", "ws-a1b2c3d4e5f60718"},
		{"大小写混合", "WS-A1B2C3D4.sites.LIGHTCLAW.tech", "ws-a1b2c3d4"},
		{"末尾根点", "ws-a1b2c3d4.sites.lightclaw.tech.", "ws-a1b2c3d4"},
		{"第二个根域", "ws-abc.sites.example.com", "ws-abc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			siteID, _, ok := r.Resolve(tc.host)
			if !ok {
				t.Fatalf("Resolve(%q) 未命中子域名模式", tc.host)
			}
			if siteID != tc.siteID {
				t.Fatalf("Resolve(%q) = %q, 期望 %q", tc.host, siteID, tc.siteID)
			}
		})
	}
}

func TestResolveFallsBackToCustomDomain(t *testing.T) {
	r := New([]string{"sites.lightclaw.tech"})

	cases := []struct {
		name           string
		host           string
		normalizedHost string
	}{
		{"完全不同的域", "example.com", "example.com"},
		{"根域自身不是站点", "sites.lightclaw.tech", "sites.lightclaw.tech"},
		// 多级子域名不属于站点命名空间：放行会让 Host→siteID 出现歧义
		// （a.b 到底是站点 "a" 的子域还是站点 "b" 的？）。
		{"多级子域名", "a.b.sites.lightclaw.tech", "a.b.sites.lightclaw.tech"},
		{"自定义域名带端口", "shop.example.com:443", "shop.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			siteID, normalized, ok := r.Resolve(tc.host)
			if ok {
				t.Fatalf("Resolve(%q) 不应命中子域名模式，却返回 %q", tc.host, siteID)
			}
			if normalized != tc.normalizedHost {
				t.Fatalf("Resolve(%q) 归一化为 %q, 期望 %q", tc.host, normalized, tc.normalizedHost)
			}
		})
	}
}

// siteID 会被拼进 COS 对象 key，非法字符必须在这一层挡住，
// 不能指望后续的站点查询兜底。
func TestResolveRejectsInvalidLabel(t *testing.T) {
	r := New([]string{"sites.lightclaw.tech"})

	for _, host := range []string{
		"-leading.sites.lightclaw.tech",
		"trailing-.sites.lightclaw.tech",
		"under_score.sites.lightclaw.tech",
		"has%2fslash.sites.lightclaw.tech",
		".sites.lightclaw.tech",
	} {
		if siteID, _, ok := r.Resolve(host); ok {
			t.Fatalf("Resolve(%q) 应拒绝非法标签，却返回 %q", host, siteID)
		}
	}
}

func TestResolveEmptyHost(t *testing.T) {
	r := New([]string{"sites.lightclaw.tech"})
	if _, _, ok := r.Resolve("   "); ok {
		t.Fatal("空 Host 不应命中")
	}
}

func TestNewIgnoresBlankRootDomains(t *testing.T) {
	r := New([]string{"", "   ", "sites.lightclaw.tech"})
	if len(r.rootDomains) != 1 {
		t.Fatalf("期望只保留 1 个根域，实际 %v", r.rootDomains)
	}
}
