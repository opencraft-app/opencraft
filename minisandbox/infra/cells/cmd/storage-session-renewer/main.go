package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rivet-dev/rivet/infra/cells/internal/storagesession"
)

func main() {
	if run() != nil {
		fmt.Fprintln(os.Stderr, "storage-session-renewer stopped: configuration, identity or health server unavailable")
		os.Exit(1)
	}
}

func run() error {
	path := flag.String("config", "/etc/storage-session-renewer/config.json", "public identity configuration")
	listen := flag.String("listen", ":8080", "health listen address")
	flag.Parse()
	config, err := storagesession.LoadConfig(*path)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	health := new(storagesession.Health)
	server := &http.Server{Addr: *listen, Handler: health, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	serveErr := make(chan error, 1)
	go func() {
		err := server.ListenAndServe()
		if err != http.ErrServerClosed {
			serveErr <- err
			stop()
		}
	}()
	err = storagesession.Run(ctx, config, health)
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
	select {
	case e := <-serveErr:
		if err == nil {
			err = e
		}
	default:
	}
	return err
}
