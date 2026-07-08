package region

import "testing"

// TestResolve 验证按 siteKind 字面量返回三元组的映射（v1.7.x 国际站接入）。
func TestResolve(t *testing.T) {
	cases := []struct {
		name           string
		siteKind       string
		regionOverride string
		want           LighthouseRegion
	}{
		{
			name:     "cn returns guangzhou",
			siteKind: "cn",
			want: LighthouseRegion{
				RegionID:   LighthouseRegionID,
				ZoneID:     LighthouseZoneID,
				RegionName: LighthouseRegionName,
			},
		},
		{
			name:     "intl returns singapore",
			siteKind: "intl",
			want: LighthouseRegion{
				RegionID:   LighthouseIntlRegionID,
				ZoneID:     LighthouseIntlZoneID,
				RegionName: LighthouseIntlRegionName,
			},
		},
		{
			name:     "empty falls back to cn",
			siteKind: "",
			want: LighthouseRegion{
				RegionID:   LighthouseRegionID,
				ZoneID:     LighthouseZoneID,
				RegionName: LighthouseRegionName,
			},
		},
		{
			name:     "bogus value falls back to cn",
			siteKind: "bogus",
			want: LighthouseRegion{
				RegionID:   LighthouseRegionID,
				ZoneID:     LighthouseZoneID,
				RegionName: LighthouseRegionName,
			},
		},
		{
			name:     "uppercase intl is not normalized in this layer",
			siteKind: "INTL", // Resolve 不做规范化；上游 config.normalizeSiteKind 负责，故 INTL 走兜底分支
			want: LighthouseRegion{
				RegionID:   LighthouseRegionID,
				ZoneID:     LighthouseZoneID,
				RegionName: LighthouseRegionName,
			},
		},
		{
			name:           "cn + ap-beijing override returns beijing",
			siteKind:       "cn",
			regionOverride: "ap-beijing",
			want:           LighthouseRegion{RegionID: 8, ZoneID: 800001, RegionName: "北京"},
		},
		{
			name:           "cn + ap-shanghai override returns shanghai",
			siteKind:       "cn",
			regionOverride: "ap-shanghai",
			want:           LighthouseRegion{RegionID: 4, ZoneID: 400001, RegionName: "上海"},
		},
		{
			name:           "intl + ap-beijing override returns beijing (override wins over siteKind)",
			siteKind:       "intl",
			regionOverride: "ap-beijing",
			want:           LighthouseRegion{RegionID: 8, ZoneID: 800001, RegionName: "北京"},
		},
		{
			name:           "cn + ap-singapore override returns singapore",
			siteKind:       "cn",
			regionOverride: "ap-singapore",
			want: LighthouseRegion{
				RegionID:   LighthouseIntlRegionID,
				ZoneID:     LighthouseIntlZoneID,
				RegionName: LighthouseIntlRegionName,
			},
		},
		{
			name:           "override is case-insensitive and trim-friendly",
			siteKind:       "cn",
			regionOverride: "  AP-Beijing  ",
			want:           LighthouseRegion{RegionID: 8, ZoneID: 800001, RegionName: "北京"},
		},
		{
			name:           "unknown override falls back to siteKind tier (defensive; config layer should fail-fast)",
			siteKind:       "intl",
			regionOverride: "ap-tokyo",
			want: LighthouseRegion{
				RegionID:   LighthouseIntlRegionID,
				ZoneID:     LighthouseIntlZoneID,
				RegionName: LighthouseIntlRegionName,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Resolve(tc.siteKind, tc.regionOverride)
			if got != tc.want {
				t.Errorf("Resolve(%q, %q) = %+v, want %+v",
					tc.siteKind, tc.regionOverride, got, tc.want)
			}
		})
	}
}

// TestLookupByRegion 验证 region 字面量 → 三元组的查表 + 大小写 / 空白容错。
func TestLookupByRegion(t *testing.T) {
	cases := []struct {
		name   string
		region string
		want   LighthouseRegion
		wantOk bool
	}{
		{"ap-guangzhou", "ap-guangzhou", LighthouseRegion{
			RegionID: LighthouseRegionID, ZoneID: LighthouseZoneID, RegionName: LighthouseRegionName,
		}, true},
		{"ap-beijing", "ap-beijing", LighthouseRegion{
			RegionID: 8, ZoneID: 800001, RegionName: "北京",
		}, true},
		{"ap-shanghai", "ap-shanghai", LighthouseRegion{
			RegionID: 4, ZoneID: 400001, RegionName: "上海",
		}, true},
		{"ap-singapore", "ap-singapore", LighthouseRegion{
			RegionID: LighthouseIntlRegionID, ZoneID: LighthouseIntlZoneID, RegionName: LighthouseIntlRegionName,
		}, true},
		{"upper case", "AP-BEIJING", LighthouseRegion{
			RegionID: 8, ZoneID: 800001, RegionName: "北京",
		}, true},
		{"with whitespace", "  ap-beijing  ", LighthouseRegion{
			RegionID: 8, ZoneID: 800001, RegionName: "北京",
		}, true},
		{"empty string returns false", "", LighthouseRegion{}, false},
		{"unknown region returns false", "ap-tokyo", LighthouseRegion{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := LookupByRegion(tc.region)
			if ok != tc.wantOk {
				t.Errorf("LookupByRegion(%q) ok = %v, want %v", tc.region, ok, tc.wantOk)
			}
			if got != tc.want {
				t.Errorf("LookupByRegion(%q) = %+v, want %+v", tc.region, got, tc.want)
			}
		})
	}
}

// TestConstants_NoCollision 守护：国内 / 国际两组常量不能重叠（合规红线）。
func TestConstants_NoCollision(t *testing.T) {
	if LighthouseRegionID == LighthouseIntlRegionID {
		t.Errorf("LighthouseRegionID(%d) collides with LighthouseIntlRegionID(%d)",
			LighthouseRegionID, LighthouseIntlRegionID)
	}
	if LighthouseZoneID == LighthouseIntlZoneID {
		t.Errorf("LighthouseZoneID(%d) collides with LighthouseIntlZoneID(%d)",
			LighthouseZoneID, LighthouseIntlZoneID)
	}
	if LighthouseRegionName == LighthouseIntlRegionName {
		t.Errorf("LighthouseRegionName(%q) collides with LighthouseIntlRegionName(%q)",
			LighthouseRegionName, LighthouseIntlRegionName)
	}
}
