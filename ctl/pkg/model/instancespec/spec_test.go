package instancespec

import "testing"

func TestResolveByID_Known(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name           string
		specID         string
		wantCPU        int
		wantMemory     int
		wantDisk       int
		wantDisplay    string
		wantResolvedID string
	}{
		{
			name:           "spec-2c4g50g",
			specID:         SpecID2C4G50G,
			wantCPU:        2,
			wantMemory:     4, // GB
			wantDisk:       50,
			wantDisplay:    "2核4G 50G系统盘",
			wantResolvedID: SpecID2C4G50G,
		},
		{
			name:           "spec-4c8g80g",
			specID:         SpecID4C8G80G,
			wantCPU:        4,
			wantMemory:     8, // GB
			wantDisk:       80,
			wantDisplay:    "4核8G 80G系统盘",
			wantResolvedID: SpecID4C8G80G,
		},
		{
			name:           "empty falls back to default",
			specID:         "",
			wantCPU:        2,
			wantMemory:     4, // GB
			wantDisk:       50,
			wantDisplay:    "2核4G 50G系统盘",
			wantResolvedID: DefaultSpecID,
		},
		{
			name:           "whitespace falls back to default",
			specID:         "   ",
			wantCPU:        2,
			wantMemory:     4, // GB
			wantDisk:       50,
			wantDisplay:    "2核4G 50G系统盘",
			wantResolvedID: DefaultSpecID,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, ok := ResolveByID(tc.specID)
			if !ok {
				t.Fatalf("ResolveByID(%q) ok=false, want true", tc.specID)
			}
			if got.SpecID != tc.wantResolvedID {
				t.Fatalf("SpecID = %q, want %q", got.SpecID, tc.wantResolvedID)
			}
			if got.CPU != tc.wantCPU {
				t.Errorf("CPU = %d, want %d", got.CPU, tc.wantCPU)
			}
			if got.Memory != tc.wantMemory {
				t.Errorf("Memory = %d, want %d", got.Memory, tc.wantMemory)
			}
			if got.SystemDiskSize != tc.wantDisk {
				t.Errorf("SystemDiskSize = %d, want %d", got.SystemDiskSize, tc.wantDisk)
			}
			if got.DisplayName != tc.wantDisplay {
				t.Errorf("DisplayName = %q, want %q", got.DisplayName, tc.wantDisplay)
			}
		})
	}
}

func TestResolveByID_Unknown(t *testing.T) {
	t.Parallel()

	if _, ok := ResolveByID("spec-nonexistent"); ok {
		t.Fatal("ResolveByID(unknown) ok=true, want false")
	}
}

func TestIsKnown(t *testing.T) {
	t.Parallel()

	cases := []struct {
		specID string
		want   bool
	}{
		{SpecID2C4G50G, true},
		{SpecID4C8G80G, true},
		{"", true},    // 兼容期合法
		{"   ", true}, // 空白视为空，兼容期合法
		{"spec-unknown", false},
		{"random", false},
	}
	for _, tc := range cases {
		if got := IsKnown(tc.specID); got != tc.want {
			t.Errorf("IsKnown(%q) = %v, want %v", tc.specID, got, tc.want)
		}
	}
}

func TestListAll(t *testing.T) {
	t.Parallel()

	all := ListAll()
	if len(all) != 2 {
		t.Fatalf("ListAll() length = %d, want 2", len(all))
	}

	// 修改返回值不应影响内部字典（防御性副本约定）
	all[0].DisplayName = "MUTATED"
	again := ListAll()
	if again[0].DisplayName == "MUTATED" {
		t.Fatal("ListAll() returned an alias of internal slice; mutation leaked")
	}
}
