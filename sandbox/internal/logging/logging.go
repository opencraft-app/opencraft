package logging

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

// Init configures the standard logger for local runs and containers.
// When LOG_FILE is set, logs are written to both stdout and the file.
func Init(component string) (func(), error) {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if component != "" {
		log.SetPrefix("[" + component + "] ")
	}

	logFile := os.Getenv("LOG_FILE")
	if logFile == "" {
		log.SetOutput(os.Stdout)
		return func() {}, nil
	}

	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		return nil, err
	}

	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}

	log.SetOutput(io.MultiWriter(os.Stdout, f))
	return func() {
		_ = f.Close()
	}, nil
}
