package client

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"

	"github.com/gorilla/websocket"
	"golang.org/x/term"
)

type Frame struct {
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Cols    int    `json:"cols,omitempty"`
	Rows    int    `json:"rows,omitempty"`
	Code    int    `json:"code,omitempty"`
}

func Run(ctx context.Context, config Config, stdin *os.File, stdout io.Writer, stderr io.Writer) error {
	wsURL, err := ResolveWebSocketURL(config.TargetURL)
	if err != nil {
		return err
	}

	headers := http.Header{}
	headers.Set("Authorization", BuildAuthorizationHeader(config.Username, config.Password))

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		return fmt.Errorf("dial websocket: %w", err)
	}
	defer conn.Close()

	var ready Frame
	if err := conn.ReadJSON(&ready); err != nil {
		return fmt.Errorf("read ready frame: %w", err)
	}
	if ready.Type == "error" {
		return fmt.Errorf("remote error: %s", ready.Message)
	}
	if ready.Type != "ready" || ready.Mode != "shell" {
		return fmt.Errorf("unexpected initial frame: type=%q mode=%q", ready.Type, ready.Mode)
	}

	restoreState, err := term.MakeRaw(int(stdin.Fd()))
	if err != nil {
		return fmt.Errorf("enable raw mode: %w", err)
	}
	defer func() {
		_ = term.Restore(int(stdin.Fd()), restoreState)
	}()

	writer := &lockedConn{conn: conn}
	if err := sendResize(writer, stdin); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, 2)

	go func() {
		errCh <- copyInput(ctx, writer, stdin)
	}()
	go func() {
		errCh <- copyOutput(ctx, conn, stdout, stderr, cancel)
	}()
	go watchResize(ctx, stdin, func() error {
		return sendResize(writer, stdin)
	})

	select {
	case <-ctx.Done():
		return nil
	case err := <-errCh:
		if err == nil {
			return nil
		}
		return err
	}
}

func sendResize(conn *lockedConn, stdin *os.File) error {
	cols, rows, err := term.GetSize(int(stdin.Fd()))
	if err != nil {
		return nil
	}
	return conn.WriteJSON(Frame{
		Type: "resize",
		Cols: cols,
		Rows: rows,
	})
}

func copyInput(ctx context.Context, conn *lockedConn, stdin *os.File) error {
	buffer := make([]byte, 1)
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		n, err := stdin.Read(buffer)
		if n > 0 {
			if writeErr := conn.WriteJSON(Frame{Type: "input", Data: string(buffer[:n])}); writeErr != nil {
				return fmt.Errorf("write input frame: %w", writeErr)
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read stdin: %w", err)
		}
	}
}

func copyOutput(ctx context.Context, conn *websocket.Conn, stdout io.Writer, stderr io.Writer, cancel context.CancelFunc) error {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		var frame Frame
		if err := conn.ReadJSON(&frame); err != nil {
			return fmt.Errorf("read websocket frame: %w", err)
		}
		switch frame.Type {
		case "output":
			if _, err := io.WriteString(stdout, frame.Data); err != nil {
				return fmt.Errorf("write stdout: %w", err)
			}
		case "error":
			if _, err := fmt.Fprintf(stderr, "\r\nremote error: %s\r\n", frame.Message); err != nil {
				return fmt.Errorf("write stderr: %w", err)
			}
		case "exit":
			if frame.Code != 0 {
				if _, err := fmt.Fprintf(stderr, "\r\nremote shell exited with code %d\r\n", frame.Code); err != nil {
					return fmt.Errorf("write exit status: %w", err)
				}
			}
			return nil
		}
	}
}

type lockedConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *lockedConn) WriteJSON(frame Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(frame)
}
