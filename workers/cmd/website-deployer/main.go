package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lightclaw/tencent-rescue-exporter/internal/website"
)

func main() {
	deployer := website.NewDeployer()
	pollInterval := 10 * time.Second

	if v := os.Getenv("POLL_INTERVAL_SECONDS"); v != "" {
		if d, err := time.ParseDuration(v + "s"); err == nil {
			pollInterval = d
		}
	}

	log.Printf("website-deployer starting, poll_interval=%v", pollInterval)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ops, err := deployer.PollOperations()
			if err != nil {
				log.Printf("poll operations error: %v", err)
				continue
			}
			for _, op := range ops {
				log.Printf("executing operation %s (type=%s, site=%s)", op.OperationID, op.OperationType, op.SiteID)
				if err := deployer.Execute(op); err != nil {
					log.Printf("execute operation %s failed: %v", op.OperationID, err)
				} else {
					log.Printf("operation %s completed", op.OperationID)
				}
			}

		case <-stop:
			log.Println("website-deployer shutting down")
			return
		}
	}
}
