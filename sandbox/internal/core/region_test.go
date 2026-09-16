package core

import "testing"

func TestRegionFromZone(t *testing.T) {
	tests := []struct {
		name    string
		zone    string
		want    string
		wantErr bool
	}{
		{name: "singapore", zone: "ap-singapore-2", want: "ap-singapore"},
		{name: "johor bahru", zone: "ap-johorbahru-1", want: "ap-johorbahru"},
		{name: "trim whitespace", zone: "  ap-singapore-4  ", want: "ap-singapore"},
		{name: "missing zone ordinal", zone: "ap-singapore", wantErr: true},
		{name: "non numeric zone ordinal", zone: "ap-singapore-a", wantErr: true},
		{name: "empty", zone: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := RegionFromZone(tt.zone)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for zone %q, got region %q", tt.zone, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("region from zone %q: %v", tt.zone, err)
			}
			if got != tt.want {
				t.Fatalf("region from zone %q = %q, want %q", tt.zone, got, tt.want)
			}
		})
	}
}
