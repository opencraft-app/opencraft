package instance

// Explicit local-only native acceptance. The small X11/RFB clients below are
// test probes, never protocol gates or production parsers. All processes belong
// to a fresh synthetic X server; no systemd units or real desktop are touched.
import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDesktopObserverNativeReadOnly(t *testing.T) {
	if os.Getenv("OPENCRAFT_DESKTOP_NATIVE_TEST") != "1" {
		t.Skip("explicit isolated Xvfb/x11vnc acceptance only")
	}
	for _, name := range []string{"Xvfb", "x11vnc"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	displayRead, displayWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer displayRead.Close()
	xvfb := exec.CommandContext(ctx, "Xvfb", "-displayfd", "3", "-screen", "0", "128x96x24", "-nolisten", "tcp", "-ac")
	xvfb.ExtraFiles = []*os.File{displayWrite}
	var xlog bytes.Buffer
	xvfb.Stderr = &xlog
	if err := xvfb.Start(); err != nil {
		displayWrite.Close()
		t.Fatal(err)
	}
	displayWrite.Close()
	defer func() { _ = xvfb.Process.Kill(); _ = xvfb.Wait() }()
	display, err := bufio.NewReader(displayRead).ReadString('\n')
	if err != nil {
		t.Fatalf("isolated X server: %v", err)
	}
	display = strings.TrimSpace(display)
	if _, err := strconv.Atoi(display); err != nil {
		t.Fatal("invalid allocated display")
	}
	x, err := net.DialTimeout("unix", "/tmp/.X11-unix/X"+display, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer x.Close()
	_ = x.SetDeadline(time.Now().Add(18 * time.Second))
	setup := make([]byte, 12)
	setup[0] = 'l'
	binary.LittleEndian.PutUint16(setup[2:], 11)
	if _, err := x.Write(setup); err != nil {
		t.Fatal(err)
	}
	head := nativeRead(t, x, 8)
	if head[0] != 1 {
		t.Fatal("X setup rejected")
	}
	info := nativeRead(t, x, int(binary.LittleEndian.Uint16(head[6:]))*4)
	vendorLen := int(binary.LittleEndian.Uint16(info[16:]))
	screenOffset := 32 + (vendorLen+3)/4*4 + int(info[21])*8
	if len(info) < screenOffset+40 {
		t.Fatal("missing synthetic X screen")
	}
	root := binary.LittleEndian.Uint32(info[screenOffset:])
	pointer := func(t *testing.T) (uint16, uint16) {
		req := make([]byte, 8)
		req[0] = 38
		binary.LittleEndian.PutUint16(req[2:], 2)
		binary.LittleEndian.PutUint32(req[4:], root)
		nativeXWrite(t, x, req)
		reply := nativeXReply(t, x)
		return binary.LittleEndian.Uint16(reply[16:]), binary.LittleEndian.Uint16(reply[18:])
	}
	keys := func(t *testing.T) []byte { nativeXWrite(t, x, []byte{44, 0, 1, 0}); return nativeXReply(t, x)[8:40] }
	clipboard := func(t *testing.T) []byte {
		req := make([]byte, 24)
		req[0] = 20
		binary.LittleEndian.PutUint16(req[2:], 6)
		binary.LittleEndian.PutUint32(req[4:], root)
		binary.LittleEndian.PutUint32(req[8:], 9)
		binary.LittleEndian.PutUint32(req[20:], 1024)
		nativeXWrite(t, x, req)
		reply := nativeXReply(t, x)
		return reply[32:]
	}
	// Keep CUT_BUFFER0 empty; the malicious VNC client attempts to replace it.
	for _, readonly := range []bool{true, false} {
		t.Run(fmt.Sprint("viewonly=", readonly), func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := listener.Addr().(*net.TCPAddr).Port
			listener.Close()
			args := desktopObserverArguments(":"+display, port)
			if !readonly {
				filtered := make([]string, 0, len(args))
				for _, arg := range args {
					if arg != "-viewonly" && arg != "-nosel" {
						filtered = append(filtered, arg)
					}
				}
				args = filtered
			}
			vnc := exec.CommandContext(ctx, "x11vnc", args...)
			vnc.Env = append(os.Environ(), "XAUTHORITY="+t.TempDir()+"/absent")
			var log bytes.Buffer
			vnc.Stderr = &log
			vnc.Stdout = &log
			if err := vnc.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = vnc.Process.Kill(); _ = vnc.Wait() }()
			var client net.Conn
			until := time.Now().Add(3 * time.Second)
			for time.Now().Before(until) {
				client, err = net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
				if err == nil {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if err != nil {
				t.Fatal("isolated VNC did not start")
			}
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(5 * time.Second))
			if string(nativeRead(t, client, 12)) != "RFB 003.008\n" {
				t.Fatal("unexpected RFB version")
			}
			nativeXWrite(t, client, []byte("RFB 003.008\n"))
			count := nativeRead(t, client, 1)[0]
			security := nativeRead(t, client, int(count))
			if !bytes.Contains(security, []byte{1}) {
				t.Fatal("observer unexpectedly requires legacy credentials")
			}
			nativeXWrite(t, client, []byte{1})
			if !bytes.Equal(nativeRead(t, client, 4), []byte{0, 0, 0, 0}) {
				t.Fatal("RFB security failed")
			}
			nativeXWrite(t, client, []byte{1}) // shared ClientInit
			init := nativeRead(t, client, 24)
			nativeRead(t, client, int(binary.BigEndian.Uint32(init[20:])))
			if init[4] != 32 {
				t.Fatal("test probe requires 32-bit native framebuffer")
			}
			nativeXWrite(t, client, []byte{2, 0, 0, 1, 0, 0, 0, 0}) // RAW only
			beforeX, beforeY := pointer(t)
			beforeKeys := append([]byte(nil), keys(t)...)
			beforeClip := append([]byte(nil), clipboard(t)...)
			// Deliberately bypass any UI gating. Key held, pointer moved and text
			// pasted by raw protocol, followed by a framebuffer request fence.
			attack := []byte{4, 1, 0, 0, 0, 0, 0, 0x61, 5, 0, 0, 20, 0, 30, 6, 0, 0, 0, 0, 0, 0, 4, 'e', 'v', 'i', 'l'}
			nativeXWrite(t, client, attack)
			nativeXWrite(t, client, []byte{3, 0, 0, 0, 0, 0, 0, 1, 0, 1})
			nativeFramebufferFence(t, client)
			afterX, afterY := pointer(t)
			afterKeys := keys(t)
			afterClip := clipboard(t)
			if readonly {
				if afterX != beforeX || afterY != beforeY || !bytes.Equal(beforeKeys, afterKeys) || !bytes.Equal(beforeClip, afterClip) {
					t.Fatal("native readonly endpoint accepted input")
				}
			} else if afterX != 20 || afterY != 30 || bytes.Equal(beforeKeys, afterKeys) || bytes.Equal(beforeClip, afterClip) {
				t.Fatal("negative control did not execute key/pointer/clipboard input; readonly proof inconclusive")
			}
			// Release negative-control key before disposing the isolated server.
			nativeXWrite(t, client, []byte{4, 0, 0, 0, 0, 0, 0, 0x61})
		})
	}
}

func nativeRead(t *testing.T, r io.Reader, n int) []byte {
	t.Helper()
	if n < 0 || n > 1<<20 {
		t.Fatal("test response too large")
	}
	data := make([]byte, n)
	if _, err := io.ReadFull(r, data); err != nil {
		t.Fatal(err)
	}
	return data
}
func nativeXWrite(t *testing.T, w io.Writer, data []byte) {
	t.Helper()
	if n, err := w.Write(data); err != nil || n != len(data) {
		t.Fatalf("test write: %d %v", n, err)
	}
}
func nativeXReply(t *testing.T, r io.Reader) []byte {
	t.Helper()
	for {
		head := nativeRead(t, r, 32)
		if head[0] == 0 {
			t.Fatalf("test X request rejected: %d", head[1])
		}
		if head[0] != 1 {
			continue
		} // e.g. MappingNotify from the negative control.
		return append(head, nativeRead(t, r, int(binary.LittleEndian.Uint32(head[4:]))*4)...)
	}
}
func nativeFramebufferFence(t *testing.T, r io.Reader) {
	t.Helper()
	for {
		kind := nativeRead(t, r, 1)[0]
		if kind == 3 {
			rest := nativeRead(t, r, 7)
			nativeRead(t, r, int(binary.BigEndian.Uint32(rest[3:])))
			continue
		}
		if kind != 0 {
			t.Fatalf("unexpected framebuffer message: %d", kind)
		}
		head := nativeRead(t, r, 3)
		count := int(binary.BigEndian.Uint16(head[1:]))
		for i := 0; i < count; i++ {
			rect := nativeRead(t, r, 12)
			if binary.BigEndian.Uint32(rect[8:]) != 0 {
				t.Fatal("test expects RAW rectangle")
			}
			nativeRead(t, r, int(binary.BigEndian.Uint16(rect[4:]))*int(binary.BigEndian.Uint16(rect[6:]))*4)
		}
		if count > 0 {
			return
		}
	}
}
