package main

import (
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/juicedata/juicefs/pkg/sqliteredis"
)

func main() {
	listenAddr := flag.String("listen", "127.0.0.1:6380", "listen address")
	dbPath := flag.String("db", "meta.db", "sqlite database path")
	flag.Parse()

	srv, err := sqliteredis.New(sqliteredis.Options{Path: *dbPath})
	if err != nil {
		log.Fatal(err)
	}
	defer srv.Close()

	ln, err := net.Listen("tcp", *listenAddr)
	if err != nil {
		log.Fatal(err)
	}

	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
		<-ch
		_ = srv.Close()
	}()

	log.Printf("sqliteredis listening on %s", ln.Addr())
	if err := srv.Serve(ln); err != nil {
		log.Fatal(err)
	}
}
