package config

import "testing"

func TestParseUinRoutes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []UinRoute
	}{
		{
			name: "single",
			raw:  "700000164995=jifei-callback-dev-a",
			want: []UinRoute{{Uin: "700000164995", RouteID: "jifei-callback-dev-a"}},
		},
		{
			name: "multiple with spaces",
			raw:  " 700000164995=jifei-callback-dev-a , 700000164996=jifei-callback-dev-b ",
			want: []UinRoute{
				{Uin: "700000164995", RouteID: "jifei-callback-dev-a"},
				{Uin: "700000164996", RouteID: "jifei-callback-dev-b"},
			},
		},
		{
			// 一处笔误不该把整张表废掉，否则所有开发者的回调一起失效。
			name: "skips malformed entries",
			raw:  "bogus,=x,700000164995=jifei-callback-dev-a,700000164996=",
			want: []UinRoute{{Uin: "700000164995", RouteID: "jifei-callback-dev-a"}},
		},
		{name: "empty", raw: "  ", want: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseUinRoutes(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("条数不对: got %d want %d (%v)", len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("第 %d 条不对: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// TestRouteUinRoutesEnvOverride 锁住「新增开发者不用重建镜像」这条运维路径。
func TestRouteUinRoutesEnvOverride(t *testing.T) {
	cfg := Config{Routes: []RouteConfig{{
		ID:        "jifei-callback",
		UinRoutes: []UinRoute{{Uin: "1", RouteID: "baked-in"}},
	}}}
	t.Setenv("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_UIN_ROUTES",
		"700000164995=jifei-callback-dev-a,700000164996=jifei-callback-dev-b")

	applyRouteEnvOverrides(&cfg)

	got := cfg.Routes[0].UinRoutes
	if len(got) != 2 {
		t.Fatalf("env 覆盖应完全替换烤进镜像的表，实际 %+v", got)
	}
	if got[0].Uin != "700000164995" || got[0].RouteID != "jifei-callback-dev-a" {
		t.Fatalf("第 1 条不对: %+v", got[0])
	}
	if got[1].Uin != "700000164996" || got[1].RouteID != "jifei-callback-dev-b" {
		t.Fatalf("第 2 条不对: %+v", got[1])
	}
}

// TestRouteUinRoutesEnvOverrideKeepsBakedTableWhenUnset 未设 env 时保留配置文件里的表。
func TestRouteUinRoutesEnvOverrideKeepsBakedTableWhenUnset(t *testing.T) {
	cfg := Config{Routes: []RouteConfig{{
		ID:        "jifei-callback",
		UinRoutes: []UinRoute{{Uin: "1", RouteID: "baked-in"}},
	}}}

	applyRouteEnvOverrides(&cfg)

	if len(cfg.Routes[0].UinRoutes) != 1 || cfg.Routes[0].UinRoutes[0].RouteID != "baked-in" {
		t.Fatalf("未设 env 时不该改动配置表，实际 %+v", cfg.Routes[0].UinRoutes)
	}
}
