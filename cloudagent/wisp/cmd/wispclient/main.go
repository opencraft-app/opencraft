package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", progName(), err)
		os.Exit(1)
	}
}

func progName() string {
	name := filepath.Base(os.Args[0])
	if strings.TrimSpace(name) == "" {
		return "wispclient"
	}
	return name
}

func run() error {
	server := flag.String("server", getenv("WISP_SERVER", "http://127.0.0.1:8520"), "remote wisp daemon base URL")
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		return usage()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := &remoteClient{
		baseURL: strings.TrimRight(*server, "/"),
		client:  &http.Client{Timeout: 10 * time.Minute},
	}

	switch args[0] {
	case "ls":
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps", nil)
	case "status":
		if len(args) != 2 {
			return errors.New("status requires a wisp name")
		}
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+url.PathEscape(args[1]), nil)
	case "create":
		if len(args) != 2 {
			return errors.New("create requires a wisp name")
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps", map[string]any{"name": args[1]})
	case "bind-backend":
		return bindBackend(ctx, client, args[1:])
	case "bootstrap":
		if len(args) > 2 {
			return errors.New("bootstrap accepts at most one optional wisp name")
		}
		body := map[string]any{}
		if len(args) == 2 {
			body["name"] = args[1]
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/runtime/bootstrap", body)
	case "start":
		if len(args) != 2 {
			return errors.New("start requires a wisp name")
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(args[1])+"/start", nil)
	case "stop":
		return stopWisp(ctx, client, args[1:])
	case "destroy":
		if len(args) != 2 {
			return errors.New("destroy requires a wisp name")
		}
		return client.callAndPrint(ctx, http.MethodDelete, "/v1/wisps/"+url.PathEscape(args[1]), nil)
	case "shell":
		if len(args) != 2 {
			return errors.New("shell requires a wisp name")
		}
		return client.execWS(ctx, args[1], nil)
	case "exec":
		if len(args) < 4 {
			return fmt.Errorf("usage: %s exec [--stream] <name> -- <cmd...>", progName())
		}
		stream := false
		offset := 1
		if args[1] == "--stream" {
			stream = true
			offset = 2
		}
		if len(args) < offset+3 || args[offset+1] != "--" {
			return fmt.Errorf("usage: %s exec [--stream] <name> -- <cmd...>", progName())
		}
		name := args[offset]
		argv := args[offset+2:]
		if stream {
			return client.execWS(ctx, name, argv)
		}
		if _, _, tty := terminalSize(os.Stdin.Fd()); !tty {
			return client.execCommand(ctx, name, argv)
		}
		return client.execWS(ctx, name, argv)
	case "checkpoint":
		return checkpoint(ctx, client, args[1:])
	case "fs":
		return filesystem(ctx, client, args[1:])
	case "fetch":
		return fetchFile(ctx, client, args[1:])
	default:
		return usage()
	}
}

func bindBackend(ctx context.Context, client *remoteClient, args []string) error {
	fs := flag.NewFlagSet("bind-backend", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	remoteBackend := fs.String("remote-backend", getenv("REMOTE_BACKEND", "smh"), "remote backend")
	smhLibraryID := fs.String("smh-library-id", getenv("SMH_LIBRARY_ID", ""), "SMH library id")
	smhAccessDomain := fs.String("smh-access-domain", getenv("SMH_ACCESS_DOMAIN", ""), "SMH access domain")
	smhSpaceID := fs.String("smh-space-id", getenv("SMH_SPACE_ID", ""), "SMH space id")
	smhAccessToken := fs.String("smh-access-token", getenv("SMH_ACCESS_TOKEN", ""), "SMH access token")
	jfsPrefix := fs.String("jfs-prefix", getenv("JFS_PREFIX", ""), "JuiceFS prefix")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()
	if len(rest) != 1 {
		return fmt.Errorf("usage: %s bind-backend [flags] <name>", progName())
	}
	name := rest[0]
	body := map[string]any{
		"name":              name,
		"remote_backend":    *remoteBackend,
		"smh_library_id":    *smhLibraryID,
		"smh_access_domain": *smhAccessDomain,
		"smh_space_id":      *smhSpaceID,
		"smh_access_token":  *smhAccessToken,
		"jfs_prefix":        *jfsPrefix,
	}
	return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(name)+"/backend", body)
}

func stopWisp(ctx context.Context, client *remoteClient, args []string) error {
	force := false
	var name string
	for _, arg := range args {
		switch arg {
		case "--force":
			force = true
		default:
			if name != "" {
				return fmt.Errorf("usage: %s stop [--force] <name>", progName())
			}
			name = arg
		}
	}
	if name == "" {
		return errors.New("stop requires a wisp name")
	}
	path := "/v1/wisps/" + url.PathEscape(name) + "/stop"
	if force {
		path += "?force=1"
	}
	return client.callAndPrint(ctx, http.MethodPost, path, nil)
}

type remoteClient struct {
	baseURL string
	client  *http.Client
}

type execCommandEnvelope struct {
	OK     bool               `json:"ok"`
	Result remoteExecResponse `json:"result"`
}

type remoteExecResponse struct {
	Wisp     string `json:"wisp"`
	Mode     string `json:"mode"`
	Status   string `json:"status"`
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
}

func (c *remoteClient) callAndPrint(ctx context.Context, method, path string, body any) error {
	var out map[string]any
	if err := c.callJSON(ctx, method, path, body, &out); err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func (c *remoteClient) callJSON(ctx context.Context, method, path string, body any, out any) error {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(buf))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		data, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *remoteClient) execCommand(ctx context.Context, name string, argv []string) error {
	var out execCommandEnvelope
	if err := c.callJSON(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(name)+"/exec", map[string]any{"argv": argv}, &out); err != nil {
		return err
	}
	if out.Result.Stdout != "" {
		if _, err := io.WriteString(os.Stdout, out.Result.Stdout); err != nil {
			return err
		}
	}
	if out.Result.Stderr != "" {
		if _, err := io.WriteString(os.Stderr, out.Result.Stderr); err != nil {
			return err
		}
	}
	if out.Result.ExitCode != 0 {
		return fmt.Errorf("remote command exited with code %d", out.Result.ExitCode)
	}
	return nil
}

func (c *remoteClient) execWS(ctx context.Context, name string, argv []string) error {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	u.Path = "/v1/wisps/" + url.PathEscape(name) + "/exec/ws"
	q := u.Query()
	for _, arg := range argv {
		q.Add("argv", arg)
	}
	cols, rows, tty := terminalSize(os.Stdin.Fd())
	if tty {
		q.Set("cols", fmt.Sprintf("%d", cols))
		q.Set("rows", fmt.Sprintf("%d", rows))
	}
	u.RawQuery = q.Encode()

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	restore, err := makeRawIfTTY(os.Stdin.Fd())
	if err != nil {
		return err
	}
	if restore != nil {
		defer restore()
	}

	if tty {
		_ = conn.WriteJSON(map[string]any{
			"type": "resize",
			"cols": cols,
			"rows": rows,
		})
	}

	errCh := make(chan error, 3)
	var writeMu sync.Mutex
	writeFrame := func(messageType int, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(messageType, payload)
	}

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if werr := writeFrame(websocket.BinaryMessage, append([]byte(nil), buf[:n]...)); werr != nil {
					errCh <- werr
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					errCh <- err
				}
				return
			}
		}
	}()

	go func() {
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) ||
					errors.Is(err, io.EOF) ||
					strings.Contains(strings.ToLower(err.Error()), "unexpected eof") {
					errCh <- nil
				} else {
					errCh <- err
				}
				return
			}
			if mt != websocket.BinaryMessage && mt != websocket.TextMessage {
				continue
			}
			if _, err := os.Stdout.Write(msg); err != nil {
				errCh <- err
				return
			}
		}
	}()

	if tty {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGWINCH)
		defer signal.Stop(sigCh)
		go func() {
			for range sigCh {
				cols, rows, ok := terminalSize(os.Stdin.Fd())
				if !ok {
					continue
				}
				_ = conn.WriteJSON(map[string]any{
					"type": "resize",
					"cols": cols,
					"rows": rows,
				})
			}
		}()
	}

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

func checkpoint(ctx context.Context, client *remoteClient, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: %s checkpoint <list|create|get|delete|restore> <wisp> [checkpoint]", progName())
	}
	switch args[0] {
	case "list":
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+url.PathEscape(args[1])+"/checkpoints", nil)
	case "create":
		body := map[string]any{}
		if len(args) >= 3 {
			body["id"] = args[2]
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(args[1])+"/checkpoints", body)
	case "get":
		if len(args) != 3 {
			return fmt.Errorf("usage: %s checkpoint get <wisp> <checkpoint>", progName())
		}
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+url.PathEscape(args[1])+"/checkpoints/"+url.PathEscape(args[2]), nil)
	case "delete":
		if len(args) != 3 {
			return fmt.Errorf("usage: %s checkpoint delete <wisp> <checkpoint>", progName())
		}
		return client.callAndPrint(ctx, http.MethodDelete, "/v1/wisps/"+url.PathEscape(args[1])+"/checkpoints/"+url.PathEscape(args[2]), nil)
	case "restore":
		if len(args) != 3 {
			return fmt.Errorf("usage: %s checkpoint restore <wisp> <checkpoint>", progName())
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(args[1])+"/checkpoints/"+url.PathEscape(args[2])+"/restore", nil)
	default:
		return fmt.Errorf("usage: %s checkpoint <list|create|get|delete|restore> <wisp> [checkpoint]", progName())
	}
}

func filesystem(ctx context.Context, client *remoteClient, args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("usage: %s fs <ls|read|write|mkdir|mv|rm|stat> <wisp> <path> [args]", progName())
	}
	wisp := url.PathEscape(args[1])
	switch args[0] {
	case "ls":
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+wisp+"/filesystem?path="+url.QueryEscape(args[2]), nil)
	case "read":
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+wisp+"/filesystem/content?path="+url.QueryEscape(args[2]), nil)
	case "write":
		if len(args) != 4 {
			return fmt.Errorf("usage: %s fs write <wisp> <path> <content>", progName())
		}
		return client.callAndPrint(ctx, http.MethodPut, "/v1/wisps/"+wisp+"/filesystem/content", map[string]any{
			"path":     args[2],
			"content":  args[3],
			"encoding": "utf-8",
		})
	case "mkdir":
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+wisp+"/filesystem/mkdir", map[string]any{"path": args[2]})
	case "mv":
		if len(args) != 4 {
			return fmt.Errorf("usage: %s fs mv <wisp> <path> <new-path>", progName())
		}
		return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+wisp+"/filesystem/rename", map[string]any{"path": args[2], "new_path": args[3]})
	case "rm":
		return client.callAndPrint(ctx, http.MethodDelete, "/v1/wisps/"+wisp+"/filesystem?path="+url.QueryEscape(args[2]), nil)
	case "stat":
		return client.callAndPrint(ctx, http.MethodGet, "/v1/wisps/"+wisp+"/filesystem/stat?path="+url.QueryEscape(args[2]), nil)
	default:
		return fmt.Errorf("usage: %s fs <ls|read|write|mkdir|mv|rm|stat> <wisp> <path> [args]", progName())
	}
}

func fetchFile(ctx context.Context, client *remoteClient, args []string) error {
	if len(args) < 3 {
		return fmt.Errorf("usage: %s fetch <wisp> <url> <path> [--sha256 <sha>] [--mode <mode>] [--max-bytes <bytes>] [--allow-private]", progName())
	}
	body := map[string]any{
		"url":  args[1],
		"path": args[2],
	}
	for i := 3; i < len(args); i++ {
		switch args[i] {
		case "--allow-private":
			body["allow_private"] = true
		case "--sha256":
			i++
			if i >= len(args) {
				return errors.New("fetch --sha256 requires a value")
			}
			body["sha256"] = args[i]
		case "--mode":
			i++
			if i >= len(args) {
				return errors.New("fetch --mode requires a value")
			}
			body["mode"] = args[i]
		case "--max-bytes":
			i++
			if i >= len(args) {
				return errors.New("fetch --max-bytes requires a value")
			}
			value, err := strconv.ParseInt(args[i], 10, 64)
			if err != nil {
				return fmt.Errorf("fetch --max-bytes must be an integer: %w", err)
			}
			body["max_bytes"] = value
		default:
			return fmt.Errorf("unknown fetch option %q", args[i])
		}
	}
	return client.callAndPrint(ctx, http.MethodPost, "/v1/wisps/"+url.PathEscape(args[0])+"/filesystem/fetch", body)
}

type termiosState struct {
	termios syscall.Termios
}

func makeRawIfTTY(fd uintptr) (func(), error) {
	state, ok, err := getTermios(fd)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	raw := state.termios
	raw.Iflag &^= syscall.IGNBRK | syscall.BRKINT | syscall.PARMRK | syscall.ISTRIP | syscall.INLCR | syscall.IGNCR | syscall.ICRNL | syscall.IXON
	raw.Oflag &^= syscall.OPOST
	raw.Lflag &^= syscall.ECHO | syscall.ECHONL | syscall.ICANON | syscall.ISIG | syscall.IEXTEN
	raw.Cflag &^= syscall.CSIZE | syscall.PARENB
	raw.Cflag |= syscall.CS8
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	if err := ioctlSetTermios(fd, &raw); err != nil {
		return nil, err
	}
	return func() { _ = ioctlSetTermios(fd, &state.termios) }, nil
}

func getTermios(fd uintptr) (*termiosState, bool, error) {
	var termios syscall.Termios
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&termios)), 0, 0, 0); errno != 0 {
		if errno == syscall.ENOTTY {
			return nil, false, nil
		}
		return nil, false, errno
	}
	return &termiosState{termios: termios}, true, nil
}

func ioctlSetTermios(fd uintptr, termios *syscall.Termios) error {
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TCSETS), uintptr(unsafe.Pointer(termios)), 0, 0, 0); errno != 0 {
		return errno
	}
	return nil
}

func terminalSize(fd uintptr) (uint16, uint16, bool) {
	type winsize struct {
		Row    uint16
		Col    uint16
		Xpixel uint16
		Ypixel uint16
	}
	var ws winsize
	if _, _, errno := syscall.Syscall6(syscall.SYS_IOCTL, fd, uintptr(syscall.TIOCGWINSZ), uintptr(unsafe.Pointer(&ws)), 0, 0, 0); errno != 0 {
		return 0, 0, false
	}
	return ws.Col, ws.Row, true
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func usage() error {
	name := progName()
	fmt.Fprintf(os.Stderr, `usage:
  %s [-server http://127.0.0.1:8520] ls
  %s [-server http://127.0.0.1:8520] status <name>
  %s [-server http://127.0.0.1:8520] bind-backend [flags] <name>
  %s [-server http://127.0.0.1:8520] create <name>
  %s [-server http://127.0.0.1:8520] bootstrap [name]
  %s [-server http://127.0.0.1:8520] start <name>
  %s [-server http://127.0.0.1:8520] stop <name>
  %s [-server http://127.0.0.1:8520] destroy <name>
  %s [-server http://127.0.0.1:8520] shell <name>
  %s [-server http://127.0.0.1:8520] exec [--stream] <name> -- <cmd...>
  %s [-server http://127.0.0.1:8520] checkpoint <list|create|get|restore> <name> [checkpoint]
  %s [-server http://127.0.0.1:8520] fs <ls|read|write|mkdir|mv|rm|stat> <name> <path> [args]
  %s [-server http://127.0.0.1:8520] fetch <name> <url> <path> [--sha256 <sha>] [--mode <mode>] [--max-bytes <bytes>]
`, name, name, name, name, name, name, name, name, name, name, name, name, name)
	return errors.New("invalid command")
}
