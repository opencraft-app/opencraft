package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.woa.com/wisp/mono/site-gateway/internal/config"
	"git.woa.com/wisp/mono/site-gateway/internal/hostroute"
	"git.woa.com/wisp/mono/site-gateway/internal/httpapi"
	"git.woa.com/wisp/mono/site-gateway/internal/origin"
	"git.woa.com/wisp/mono/site-gateway/internal/sitemeta"
	"git.woa.com/wisp/mono/site-gateway/internal/usage"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	fetcher, err := origin.NewCOSFetcher(origin.COSOptions{
		Bucket:    cfg.COSBucket,
		Region:    cfg.COSRegion,
		SecretID:  cfg.COSSecretID,
		SecretKey: cfg.COSSecretKey,
		Timeout:   cfg.COSTimeout,
	})
	if err != nil {
		log.Fatalf("build cos fetcher: %v", err)
	}

	meter := usage.NewMeter(cfg.UsageMaxSites)
	reporter := usage.NewReporter(usage.ReporterOptions{
		Meter:    meter,
		Sink:     usage.NewHTTPSink(cfg.CTLBaseURL, cfg.CTLInternalToken, &http.Client{Timeout: cfg.CTLTimeout}),
		Interval: cfg.UsageReportInterval,
	})

	siteMetaClient := sitemeta.NewClient(sitemeta.Options{
		BaseURL:       cfg.CTLBaseURL,
		InternalToken: cfg.CTLInternalToken,
		HTTPClient:    &http.Client{Timeout: cfg.CTLTimeout},
		PositiveTTL:   cfg.SitePositiveTTL,
		NegativeTTL:   cfg.SiteNegativeTTL,
		MaxEntries:    cfg.SiteCacheMaxEntries,
	})

	siteHandler := httpapi.NewSiteHandler(httpapi.Options{
		Resolver:     hostroute.New(cfg.RootDomains),
		Sites:        siteMetaClient,
		DomainLookup: siteMetaClient,
		Origin:       fetcher,
		Usage:        meter,
	})

	siteServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           siteHandler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	adminServer := &http.Server{
		Addr:              cfg.AdminAddr,
		Handler:           httpapi.NewAdminHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("site-gateway serving sites on %s for root domains %v", cfg.Addr, cfg.RootDomains)
		if err := siteServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve sites: %v", err)
		}
	}()
	go func() {
		log.Printf("site-gateway admin listening on %s", cfg.AdminAddr)
		if err := adminServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("serve admin: %v", err)
		}
	}()

	reporterCtx, stopReporter := context.WithCancel(context.Background())
	reporterDone := make(chan struct{})
	go func() {
		defer close(reporterDone)
		log.Printf("site-gateway reporting site usage every %s", cfg.UsageReportInterval)
		reporter.Run(reporterCtx)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := siteServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown sites: %v", err)
	}
	if err := adminServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown admin: %v", err)
	}
	// 先停站点服务再停上报：这个顺序保证最后一次 Flush 看到的是已经不再增长的计数，
	// 不会漏掉关服过程中仍在处理的那几个请求。
	stopReporter()
	<-reporterDone
}
