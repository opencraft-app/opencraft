package main

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"

	api "cvm-mock-e2b/api-gin/gen"
	"cvm-mock-e2b/internal/observability"
	"cvm-mock-e2b/internal/provider"
	"cvm-mock-e2b/internal/route"
)

func main() {
	cfg := loadConfig()
	svc, err := buildService(cfg)
	if err != nil {
		log.Fatalf("init service: %v", err)
	}
	routes, err := route.NewRedisStore(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB, cfg.RedisRoutePrefix)
	if err != nil {
		log.Fatalf("init redis route store: %v", err)
	}
	var commands provider.CommandRunner
	var invocations provider.CommandInvoker
	var terminals provider.TerminalSessionStarter
	var terminalCommands provider.TerminalCommandStreamer
	cp, err := provider.ResolveFromEnv()
	if err != nil {
		log.Printf("init provider failed; tat commands unavailable: %v", err)
	} else {
		if runner, ok := cp.(provider.CommandRunner); ok {
			commands = runner
		}
		if invoker, ok := cp.(provider.CommandInvoker); ok {
			invocations = invoker
		}
		if starter, ok := cp.(provider.TerminalSessionStarter); ok {
			terminals = starter
		}
		if streamer, ok := cp.(provider.TerminalCommandStreamer); ok {
			terminalCommands = streamer
		}
	}
	apiMetrics := observability.NewAPIMetrics(prometheus.NewRegistry())
	h := &handler{
		svc:                 svc,
		routes:              routes,
		commands:            commands,
		invocations:         invocations,
		terminals:           terminals,
		terminalCommands:    terminalCommands,
		cloud:               cp,
		metrics:             apiMetrics,
		allowedTATCommandID: cfg.AllowedTATCommandID,
		cloudPauseResume:    cfg.CloudPauseResume,
	}

	r := gin.New()
	r.Use(gin.Recovery(), gin.Logger(), apiMetrics.Middleware())
	r.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/metrics", gin.WrapH(apiMetrics.Handler()))

	api.RegisterHandlers(r, h)
	authenticated := r.Group("/")
	authenticated.Use(userSessionAuth(cfg.AuthServiceURL))
	registerTATRoutes(authenticated, h)

	internal := r.Group("/internal")
	registerPoolRoutes(internal, h)
	registerTemplateClassRoutes(internal, h)
	registerInternalTATStreamRoute(internal, h)
	internalInvocations := internal.Group("")
	internalInvocations.Use(internalAPIKeyAuth(cfg.InternalAPIKey))
	registerInternalTATInvocationRoutes(internalInvocations, h)

	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      r,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
	}
	log.Printf("gin api listening on %s", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
