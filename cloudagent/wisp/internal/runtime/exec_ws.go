package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type execResizeMessage struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func (r *Runtime) execPTY(ctx context.Context, argv []string, cols, rows uint16) (*exec.Cmd, *os.File, error) {
	if err := requireRoot(); err != nil {
		return nil, nil, err
	}
	args, err := r.execArgs(ctx, argv)
	if err != nil {
		return nil, nil, err
	}

	cmd := exec.CommandContext(ctx, r.cfg.CrunBinaryPath, args...)
	size := &pty.Winsize{Cols: cols, Rows: rows}
	if size.Cols == 0 {
		size.Cols = 120
	}
	if size.Rows == 0 {
		size.Rows = 40
	}
	ptmx, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return nil, nil, err
	}
	return cmd, ptmx, nil
}

func streamPTYOverWebsocket(ctx context.Context, conn *websocket.Conn, ptmx *os.File, cmd *exec.Cmd) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer ptmx.Close()

	var writeMu sync.Mutex
	writeFrame := func(messageType int, payload []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteMessage(messageType, payload)
	}

	errCh := make(chan error, 3)

	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				data := append([]byte(nil), buf[:n]...)
				if werr := writeFrame(websocket.BinaryMessage, data); werr != nil {
					errCh <- werr
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) {
					errCh <- nil
				} else {
					errCh <- err
				}
				return
			}
		}
	}()

	go func() {
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			if messageType == websocket.TextMessage {
				var resize execResizeMessage
				if err := json.Unmarshal(data, &resize); err == nil && resize.Type == "resize" {
					if resize.Cols > 0 || resize.Rows > 0 {
						size := &pty.Winsize{Cols: resize.Cols, Rows: resize.Rows}
						if size.Cols == 0 {
							size.Cols = 120
						}
						if size.Rows == 0 {
							size.Rows = 40
						}
						_ = pty.Setsize(ptmx, size)
						continue
					}
				}
			}
			if len(data) == 0 {
				continue
			}
			if _, err := ptmx.Write(data); err != nil {
				errCh <- err
				return
			}
		}
	}()

	go func() {
		errCh <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return ctx.Err()
	case err := <-errCh:
		_ = cmd.Process.Signal(syscall.SIGHUP)
		if err == nil {
			return nil
		}
		if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
			return nil
		}
		return err
	}
}
