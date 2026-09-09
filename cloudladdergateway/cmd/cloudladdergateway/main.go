package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/openclaw/openclaw/mono/cloudladdergateway/gen/cloudladdergateway/v1/gatewayv1connect"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/audit"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/auth"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/config"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/devroute"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/proxy"
	"github.com/openclaw/openclaw/mono/cloudladdergateway/internal/server"
)

func main() {
	configPath := flag.String("config", envOrDefault("CLOUDLADDERGATEWAY_CONFIG", "config.example.yaml"), "config yaml path")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	authenticator, err := auth.New(cfg)
	if err != nil {
		log.Fatalf("build authenticator: %v", err)
	}
	auditor, shutdownAudit, err := audit.New(context.Background(), cfg.Audit, os.Stdout)
	if err != nil {
		log.Fatalf("build audit pipeline: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdownAudit(ctx); err != nil {
			log.Printf("shutdown audit pipeline: %v", err)
		}
	}()

	engine, err := proxy.NewEngine(cfg, proxy.WithAuditor(auditor))
	if err != nil {
		log.Fatalf("build proxy engine: %v", err)
	}

	uinRoutes := map[string][]config.UinRoute{}
	for _, route := range cfg.Routes {
		if len(route.UinRoutes) > 0 {
			uinRoutes[route.ID] = route.UinRoutes
			for _, rule := range route.UinRoutes {
				log.Printf("uin route: %s uin=%s -> %s", route.ID, rule.Uin, rule.RouteID)
			}
		}
	}
	developerRoutes, registrationHandler, err := buildDeveloperRouteRuntime(cfg, authenticator, auditor)
	if err != nil {
		log.Fatalf("build developer route runtime: %v", err)
	}

	mux := http.NewServeMux()
	connectPath, connectHandler := gatewayv1connect.NewCloudLadderGatewayServiceHandler(server.NewConnectService(engine, authenticator))
	mux.Handle(connectPath, connectHandler)
	if registrationHandler != nil {
		mux.Handle("/v1/dev-environments/registration", registrationHandler)
		log.Printf("developer route registration enabled route=%s store=%s", cfg.DeveloperRoutes.RouteID, cfg.DeveloperRoutes.Store)
	}
	mux.Handle("/", server.NewGinRouterWithDeveloperRoutes(engine, authenticator, cfg.MaxBodyBytes, uinRoutes, developerRoutes, cfg.External...))

	httpServer := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("cloudladdergateway listening on %s routes=%d connect_path=%s", cfg.Addr, len(cfg.Routes), connectPath)
		errCh <- httpServer.ListenAndServe()
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-signalCh:
		log.Printf("received signal %s, shutting down", sig)
		if err := httpServer.Close(); err != nil {
			log.Printf("close server: %v", err)
		}
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}
}

func buildDeveloperRouteRuntime(cfg config.Config, authenticator *auth.Authenticator, auditor audit.Auditor) (server.DeveloperRoutes, http.Handler, error) {
	if !cfg.DeveloperRoutes.Enabled {
		return server.DeveloperRoutes{}, nil, nil
	}
	var store devroute.Store
	switch strings.ToLower(strings.TrimSpace(cfg.DeveloperRoutes.Store)) {
	case "memory":
		store = devroute.NewMemoryStore()
	case "kubernetes_lease":
		leaseStore, err := devroute.NewInClusterKubernetesLeaseStore(
			cfg.DeveloperRoutes.LeaseNamespace,
			cfg.DeveloperRoutes.LeasePrefix,
			cfg.DeveloperRoutes.AllowedCIDRs,
			cfg.DeveloperRoutes.AllowedPorts,
			cfg.DeveloperRoutes.DeliveryMode,
			cfg.DeveloperRoutes.TunnelBaseURL,
			cfg.DeveloperRoutes.TunnelHostSuffix,
		)
		if err != nil {
			return server.DeveloperRoutes{}, nil, err
		}
		store = leaseStore
	default:
		return server.DeveloperRoutes{}, nil, fmt.Errorf("unsupported developer route store %q", cfg.DeveloperRoutes.Store)
	}
	defaultTTL, err := config.ParseDuration(cfg.DeveloperRoutes.DefaultTTL, 8*time.Hour)
	if err != nil {
		return server.DeveloperRoutes{}, nil, err
	}
	maxTTL, err := config.ParseDuration(cfg.DeveloperRoutes.MaxTTL, 24*time.Hour)
	if err != nil {
		return server.DeveloperRoutes{}, nil, err
	}
	probeTimeout, err := config.ParseDuration(cfg.DeveloperRoutes.ProbeTimeout, 5*time.Second)
	if err != nil {
		return server.DeveloperRoutes{}, nil, err
	}
	probeClient := &http.Client{Timeout: probeTimeout}
	registrationAPI, err := devroute.NewAPI(devroute.APIOptions{
		Store:              store,
		Authenticator:      authenticator,
		TargetProbe:        devroute.NewHTTPProbe(cfg.DeveloperRoutes.ProbePath, probeClient),
		AllowedCIDRs:       cfg.DeveloperRoutes.AllowedCIDRs,
		AllowedPorts:       cfg.DeveloperRoutes.AllowedPorts,
		RegistrationRoute:  cfg.DeveloperRoutes.RegistrationRoute,
		RegistrationCaller: cfg.DeveloperRoutes.RegistrationCaller,
		DeliveryMode:       cfg.DeveloperRoutes.DeliveryMode,
		TunnelBaseURL:      cfg.DeveloperRoutes.TunnelBaseURL,
		TunnelHostSuffix:   cfg.DeveloperRoutes.TunnelHostSuffix,
		Auditor:            auditor,
		DefaultTTL:         defaultTTL,
		MaxTTL:             maxTTL,
	})
	if err != nil {
		return server.DeveloperRoutes{}, nil, err
	}
	tunnelAuthorization := ""
	if strings.EqualFold(strings.TrimSpace(cfg.DeveloperRoutes.DeliveryMode), devroute.DeliveryModeDevtunnel) {
		token := strings.TrimSpace(os.Getenv(cfg.DeveloperRoutes.TunnelTokenEnv))
		if token == "" {
			return server.DeveloperRoutes{}, nil, fmt.Errorf("developer route tunnel token env %s is empty", cfg.DeveloperRoutes.TunnelTokenEnv)
		}
		tunnelAuthorization = "Bearer " + token
	}
	return server.DeveloperRoutes{
		RouteID:             cfg.DeveloperRoutes.RouteID,
		Store:               store,
		Auditor:             auditor,
		TunnelAuthorization: tunnelAuthorization,
	}, registrationAPI, nil
}

func envOrDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
