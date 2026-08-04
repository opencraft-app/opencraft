package localstate

import (
	"path/filepath"
	"testing"
)

func TestResolveRootPriorityAndRelativePaths(t *testing.T) {
	t.Parallel()

	workingDirectory := filepath.Join(string(filepath.Separator), "work", "vela")
	tests := []struct {
		name     string
		explicit string
		env      string
		want     string
	}{
		{
			name:     "explicit wins",
			explicit: "./explicit",
			env:      "/environment",
			want:     filepath.Join(workingDirectory, "explicit"),
		},
		{
			name: "environment fallback",
			env:  "./environment",
			want: filepath.Join(workingDirectory, "environment"),
		},
		{
			name: "home directory default",
			want: filepath.Join(string(filepath.Separator), "Users", "example", ".vela", "state"),
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := ResolveRoot(
				test.explicit,
				func(key string) string {
					switch key {
					case EnvironmentName:
						return test.env
					case "HOME":
						return filepath.Join(string(filepath.Separator), "Users", "example")
					default:
						t.Fatalf("environment key = %q", key)
						return ""
					}
				},
				func() (string, error) {
					return workingDirectory, nil
				},
			)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("root = %q, want %q", got, test.want)
			}
		})
	}
}
