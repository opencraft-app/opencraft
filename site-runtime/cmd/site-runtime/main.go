//go:build linux || darwin

package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	goruntime "runtime"
	"syscall"
	"time"

	runtime "git.woa.com/wisp/mono/site-runtime/internal/runtime"
)

func main() {
	driver := os.Getenv("WEBSITE_RUNTIME_DRIVER")
	if goruntime.GOOS != "linux" && driver != "minisandbox" {
		log.Fatal("production runtime requires Linux with Docker/runsc; host execution is prohibited")
	}
	addr := os.Getenv("WEBSITE_RUNTIME_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8090"
	}
	tlsConfig, err := listenerTLS(addr, os.Getenv("WEBSITE_RUNTIME_TLS_CERT_FILE"), os.Getenv("WEBSITE_RUNTIME_TLS_KEY_FILE"))
	if err != nil {
		log.Fatal(err)
	}
	dir := os.Getenv("WEBSITE_RUNTIME_DATA_DIR")
	if dir == "" {
		log.Fatal("WEBSITE_RUNTIME_DATA_DIR required")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Fatal(err)
	}
	lock, err := os.OpenFile(dir+"/.manager.lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		log.Fatal("runtime store already owned")
	}
	var runner runtime.Runner
	switch driver {
	case "minisandbox":
		runner, err = runtime.NewMinisandboxRunner(os.Getenv("WEBSITE_MINISANDBOX_API_URL"), os.Getenv("WEBSITE_MINISANDBOX_SCOPE"))
		if err != nil {
			log.Fatal(err)
		}
	case "", "runsc":
		docker, createErr := runtime.NewDockerRunner(os.Getenv("WEBSITE_RUNTIME_IMAGE"), dir)
		if createErr != nil {
			log.Fatal(createErr)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err = docker.Reconcile(ctx)
		cancel()
		if err != nil {
			log.Fatal("runtime reconciliation failed: ", err)
		}
		ctx, cancel = context.WithTimeout(context.Background(), 20*time.Second)
		err = docker.Preflight(ctx, dir)
		cancel()
		if err != nil {
			log.Fatal("runtime preflight failed: ", err)
		}
		runner = docker
	default:
		log.Fatal("unknown WEBSITE_RUNTIME_DRIVER; no fallback is permitted")
	}
	service, err := runtime.New(runtime.Options{DataDir: dir, DeployToken: os.Getenv("WEBSITE_RUNTIME_DEPLOY_TOKEN"), InvokeToken: os.Getenv("WEBSITE_RUNTIME_INVOKE_TOKEN"), Runner: runner, Concurrency: 8, SiteConcurrency: 2})
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: addr, TLSConfig: tlsConfig, Handler: service, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: runtime.PrepareTimeout + runtime.RollbackTimeout + 5*time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	signals, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-signals.Done()
		ctx, cancel := context.WithTimeout(context.Background(), runtime.PrepareTimeout+runtime.RollbackTimeout+10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Print("shutdown deadline exceeded")
		}
	}()
	log.Print("website runtime starting; internal API only")
	if tlsConfig != nil {
		err = server.ListenAndServeTLS("", "")
	} else {
		err = server.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
