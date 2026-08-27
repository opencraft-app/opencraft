package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	envdprocess "ctl/pkg/adapter/sandbox/envdprocess"
	"ctl/pkg/adapter/sandbox/envdprocessconnect"
	_ "github.com/go-sql-driver/mysql"
)

const localSandboxHeader = "X-Localstack-Sandbox-ID"

type processInvocation struct {
	SandboxID     string
	Executable    string
	ArgCount      int
	CommandSHA256 string
}

type processResult struct {
	ID       int64
	Status   string
	ExitCode int32
}

type processStore interface {
	Start(context.Context, processInvocation) (int64, error)
	Finish(context.Context, int64, processResult) error
}

type processServer struct {
	envdprocessconnect.UnimplementedProcessHandler
	store   processStore
	nextPID atomic.Uint32
}

func newProcessServer(store processStore) *processServer {
	server := &processServer{store: store}
	server.nextPID.Store(1000)
	return server
}

func (s *processServer) Start(
	ctx context.Context,
	req *connect.Request[envdprocess.StartRequest],
	stream *connect.ServerStream[envdprocess.StartResponse],
) error {
	process := req.Msg.GetProcess()
	if process == nil || strings.TrimSpace(process.GetCmd()) == "" {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("process command is required"))
	}

	invocation := sanitizeInvocation(
		req.Header().Get(localSandboxHeader),
		process.GetCmd(),
		process.GetArgs(),
	)
	recordID, err := s.store.Start(ctx, invocation)
	if err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("record process start: %w", err))
	}

	pid := s.nextPID.Add(1)
	if err := stream.Send(&envdprocess.StartResponse{
		Event: &envdprocess.ProcessEvent{
			Event: &envdprocess.ProcessEvent_Start{
				Start: &envdprocess.ProcessEvent_StartEvent{Pid: pid},
			},
		},
	}); err != nil {
		_ = s.store.Finish(ctx, recordID, processResult{Status: "STREAM_ERROR", ExitCode: 1})
		return err
	}

	result := processResult{Status: "SUCCESS", ExitCode: 0}
	if err := s.store.Finish(ctx, recordID, result); err != nil {
		return connect.NewError(connect.CodeInternal, fmt.Errorf("record process finish: %w", err))
	}
	return stream.Send(&envdprocess.StartResponse{
		Event: &envdprocess.ProcessEvent{
			Event: &envdprocess.ProcessEvent_End{
				End: &envdprocess.ProcessEvent_EndEvent{
					ExitCode: result.ExitCode,
					Exited:   true,
					Status:   result.Status,
				},
			},
		},
	})
}

func newHTTPHandler(store processStore) http.Handler {
	processHandler := newProcessServer(store)
	_, handler := envdprocessconnect.NewProcessHandler(processHandler)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/process.Process/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set(localSandboxHeader, sandboxIDFromHost(r.Host))
		handler.ServeHTTP(w, r)
	}))
	return mux
}

func sanitizeInvocation(sandboxID, executable string, args []string) processInvocation {
	command := strings.Join(append([]string{executable}, args...), "\x00")
	sum := sha256.Sum256([]byte(command))
	return processInvocation{
		SandboxID:     strings.TrimSpace(sandboxID),
		Executable:    strings.TrimSpace(executable),
		ArgCount:      len(args),
		CommandSHA256: hex.EncodeToString(sum[:]),
	}
}

func sandboxIDFromHost(host string) string {
	host = strings.Split(strings.TrimSpace(host), ":")[0]
	const prefix = "49983-"
	const suffix = "-00000000.e2b.app"
	if strings.HasPrefix(host, prefix) && strings.HasSuffix(host, suffix) {
		return strings.TrimSuffix(strings.TrimPrefix(host, prefix), suffix)
	}
	return ""
}

type mysqlProcessStore struct {
	db *sql.DB
}

func (s *mysqlProcessStore) Start(ctx context.Context, invocation processInvocation) (int64, error) {
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO sandbox.local_envd_processes
			(sandbox_id, executable, arg_count, command_sha256, status)
		VALUES (?, ?, ?, ?, 'RUNNING')`,
		invocation.SandboxID,
		invocation.Executable,
		invocation.ArgCount,
		invocation.CommandSHA256,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func (s *mysqlProcessStore) Finish(ctx context.Context, id int64, result processResult) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE sandbox.local_envd_processes
		SET status = ?, exit_code = ?, updated_at = CURRENT_TIMESTAMP(6)
		WHERE id = ?`,
		result.Status,
		result.ExitCode,
		id,
	)
	return err
}

func openMySQLStore(ctx context.Context) (*mysqlProcessStore, error) {
	host := getenv("MYSQL_HOST", "mysql.localstack-system.svc.cluster.local")
	port := getenv("MYSQL_PORT", "3306")
	user := getenv("MYSQL_USER", "root")
	password := os.Getenv("MYSQL_PASSWORD")
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/?parseTime=true&multiStatements=true", user, password, host, port)

	var lastErr error
	for attempt := 0; attempt < 60; attempt++ {
		db, err := sql.Open("mysql", dsn)
		if err == nil {
			pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err = db.PingContext(pingCtx)
			cancel()
		}
		if err == nil {
			if err = ensureSchema(ctx, db); err == nil {
				return &mysqlProcessStore{db: db}, nil
			}
		}
		if db != nil {
			_ = db.Close()
		}
		lastErr = err
		time.Sleep(time.Second)
	}
	return nil, fmt.Errorf("connect to localstack MySQL: %w", lastErr)
}

func ensureSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
		CREATE DATABASE IF NOT EXISTS sandbox
			CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
		CREATE TABLE IF NOT EXISTS sandbox.local_envd_processes (
			id BIGINT NOT NULL AUTO_INCREMENT,
			sandbox_id VARCHAR(128) NOT NULL DEFAULT '',
			executable VARCHAR(255) NOT NULL,
			arg_count INT NOT NULL,
			command_sha256 CHAR(64) NOT NULL,
			status VARCHAR(32) NOT NULL,
			exit_code INT NULL,
			created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
			updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
				ON UPDATE CURRENT_TIMESTAMP(6),
			PRIMARY KEY (id),
			KEY idx_local_envd_sandbox_created (sandbox_id, created_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
	`)
	return err
}

func getenv(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func main() {
	ctx := context.Background()
	store, err := openMySQLStore(ctx)
	if err != nil {
		log.Fatal(err)
	}

	port := getenv("FAKE_ENVD_PORT", "19050")
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatalf("invalid FAKE_ENVD_PORT %q", port)
	}
	addr := ":" + port
	log.Printf("fake envd listening on %s", addr)
	if err := http.ListenAndServe(addr, newHTTPHandler(store)); err != nil {
		log.Fatal(err)
	}
}
