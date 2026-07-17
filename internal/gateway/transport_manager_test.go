package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type trackedTransport struct {
	id         int
	closeCalls atomic.Int32
}

func (t *trackedTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, nil }
func (t *trackedTransport) CloseIdleConnections()                           { t.closeCalls.Add(1) }

func TestTransportManagerRotatesByRouteRevisionAndRetiresOldPool(t *testing.T) {
	var created atomic.Int32
	transports := map[int]*trackedTransport{}
	manager := NewTransportManager(func() http.RoundTripper {
		id := int(created.Add(1))
		transport := &trackedTransport{id: id}
		transports[id] = transport
		return transport
	}, 20*time.Millisecond)
	defer manager.Close()

	first, err := manager.Get("set-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.Get("set-a", 11)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("route revision change reused the old transport")
	}
	if got := transports[1].closeCalls.Load(); got != 1 {
		t.Fatalf("old transport close calls after switch=%d, want 1", got)
	}

	time.Sleep(60 * time.Millisecond)
	if got := transports[1].closeCalls.Load(); got != 2 {
		t.Fatalf("old transport close calls after drain=%d, want 2", got)
	}
	if _, err := manager.Get("set-a", 10); err == nil {
		t.Fatal("retired route revision unexpectedly recreated a transport")
	}
}

func TestTransportManagerRollbackRevisionCreatesFreshPool(t *testing.T) {
	var created atomic.Int32
	manager := NewTransportManager(func() http.RoundTripper {
		return &trackedTransport{id: int(created.Add(1))}
	}, time.Minute)
	defer manager.Close()

	blue, err := manager.Get("set-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	green, err := manager.Get("set-a", 11)
	if err != nil {
		t.Fatal(err)
	}
	rollbackBlue, err := manager.Get("set-a", 12)
	if err != nil {
		t.Fatal(err)
	}
	if blue == green || green == rollbackBlue || blue == rollbackBlue {
		t.Fatal("rollback reused a connection pool from an earlier route revision")
	}
}

func TestTransportManagerRotationDoesNotCancelActiveRequest(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseResponse := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(requestStarted)
		<-releaseResponse
		_, _ = io.WriteString(w, "completed on blue")
	}))
	defer server.Close()

	manager := NewTransportManager(func() http.RoundTripper {
		return &http.Transport{}
	}, 20*time.Millisecond)
	defer manager.Close()
	blue, err := manager.Get("set-a", 10)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		resp, err := (&http.Client{Transport: blue}).Get(server.URL)
		if err == nil {
			defer resp.Body.Close()
			body, readErr := io.ReadAll(resp.Body)
			if readErr != nil {
				err = readErr
			} else if string(body) != "completed on blue" {
				err = io.ErrUnexpectedEOF
			}
		}
		result <- err
	}()
	select {
	case <-requestStarted:
	case <-time.After(time.Second):
		t.Fatal("blue request did not start")
	}
	if _, err := manager.Get("set-a", 11); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	close(releaseResponse)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("active blue request was interrupted: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("active blue request did not finish")
	}
}
