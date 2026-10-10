package hermes

import (
	"errors"
	"os"
	"strings"
)

func detectContainerEvidence() string {
	for _, key := range []string{
		"container",
		"CONTAINER",
		"KUBERNETES_SERVICE_HOST",
	} {
		if value, present := os.LookupEnv(key); present &&
			strings.TrimSpace(value) != "" {
			return "environment " + key
		}
	}
	for _, path := range []string{
		"/.dockerenv",
		"/run/.containerenv",
		"/run/systemd/container",
	} {
		if _, err := os.Lstat(path); err == nil {
			return "container marker " + path
		} else if !errors.Is(err, os.ErrNotExist) {
			return "unverifiable container marker " + path
		}
	}
	data, err := os.ReadFile("/proc/1/cgroup")
	if err == nil {
		lower := strings.ToLower(string(data))
		for _, marker := range []string{
			"docker",
			"kubepods",
			"containerd",
			"podman",
			"lxc",
		} {
			if strings.Contains(lower, marker) {
				return "process cgroup " + marker
			}
		}
	}
	return ""
}
