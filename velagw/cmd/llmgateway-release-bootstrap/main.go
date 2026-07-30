package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"git.woa.com/wisp/mono2/llmgateway/internal/gateway"
	"git.woa.com/wisp/mono2/llmgateway/internal/releasebootstrap"
)

func main() {
	cfg, err := configFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := releasebootstrap.Ensure(ctx, &http.Client{Timeout: 15 * time.Second}, cfg); err != nil {
		log.Fatal(err)
	}
	log.Printf("release bootstrap ready: release=%s fleet=%s/%s/%s", cfg.Release.ID, cfg.Release.Source, cfg.Release.Namespace, cfg.Release.Fleet)
}

func configFromEnv() (releasebootstrap.Config, error) {
	releaseID := strings.TrimSpace(os.Getenv("LLMGATEWAY_RELEASE_ID"))
	releaseVersion := strings.TrimSpace(os.Getenv("LLMGATEWAY_RELEASE_VERSION"))
	releaseImage := strings.TrimSpace(os.Getenv("LLMGATEWAY_RELEASE_IMAGE"))
	if releaseID == "" || releaseVersion == "" || releaseImage == "" {
		return releasebootstrap.Config{}, fmt.Errorf("LLMGATEWAY_RELEASE_ID, LLMGATEWAY_RELEASE_VERSION and LLMGATEWAY_RELEASE_IMAGE are required")
	}
	source := envDefault("LLMGATEWAY_RELEASE_SOURCE", "prod")
	namespace := envDefault("LLMGATEWAY_RELEASE_NAMESPACE", "llmgateway")
	fleet := envDefault("LLMGATEWAY_RELEASE_FLEET", "prod")
	config := releasebootstrap.Config{
		ControlURL: envDefault("LLMGATEWAY_CONTROL_URL", "http://llmgateway-control"),
		AdminToken: strings.TrimSpace(os.Getenv("CLUSTER_ADMIN_TOKEN")),
		Release: gateway.CreateNewAPIReleaseInput{
			ID: releaseID, Source: source, Namespace: namespace, Fleet: fleet,
			Version: releaseVersion, Image: releaseImage, Compatibility: "expand_compatible",
			Status: gateway.NewAPIReleaseStatusStable,
		},
	}
	for index, ring := range []struct {
		id        string
		name      string
		admission bool
	}{
		{id: "prod-canary", name: "Canary"},
		{id: "prod-early", name: "Early"},
		{id: "prod-stable", name: "Stable", admission: true},
	} {
		config.Rings = append(config.Rings, releasebootstrap.Ring{
			Input: gateway.UpsertReleaseRingInput{
				ID: ring.id, Source: source, Namespace: namespace, Fleet: fleet, Name: ring.name,
				Ordinal: (index + 1) * 10, ServingReleaseID: releaseID, AdmissionEnabled: ring.admission, MaxParallel: 1,
			},
			SoakSeconds: 60,
		})
	}
	return config, nil
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
