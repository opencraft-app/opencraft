package usage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type recordingSink struct {
	mu      sync.Mutex
	batches [][]Sample
	windows []string
	err     error
}

func (s *recordingSink) Report(_ context.Context, windowID string, samples []Sample) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	batch := make([]Sample, len(samples))
	copy(batch, samples)
	s.batches = append(s.batches, batch)
	s.windows = append(s.windows, windowID)
	return nil
}

func (s *recordingSink) snapshot() [][]Sample {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([][]Sample, len(s.batches))
	copy(out, s.batches)
	return out
}

func find(t *testing.T, samples []Sample, siteID string) Sample {
	t.Helper()
	for _, sample := range samples {
		if sample.SiteID == siteID {
			return sample
		}
	}
	t.Fatalf("样本里没有 %s，实际 %+v", siteID, samples)
	return Sample{}
}

// 一个窗口内多次请求必须按站点合并成一条，而不是逐请求上报。
func TestAggregatesPerSiteWithinWindow(t *testing.T) {
	meter := NewMeter(0)
	meter.Record("ws-a", 100)
	meter.Record("ws-a", 250)
	meter.Record("ws-b", 7)

	samples := meter.Drain()
	if len(samples) != 2 {
		t.Fatalf("上报条目数 = %d，期望 2（按站点合并）", len(samples))
	}
	a := find(t, samples, "ws-a")
	if a.TrafficBytes != 350 || a.RequestCount != 2 {
		t.Fatalf("ws-a = %+v，期望 350 字节 / 2 次请求", a)
	}
	b := find(t, samples, "ws-b")
	if b.TrafficBytes != 7 || b.RequestCount != 1 {
		t.Fatalf("ws-b = %+v，期望 7 字节 / 1 次请求", b)
	}
}

// Drain 是「取出即清零」：下一个窗口必须从 0 开始，否则每个窗口都会把之前的量重复上报。
func TestDrainResetsCounters(t *testing.T) {
	meter := NewMeter(0)
	meter.Record("ws-a", 100)
	if got := meter.Drain(); len(got) != 1 {
		t.Fatalf("首次 Drain 应有 1 条，实际 %d", len(got))
	}
	if got := meter.Drain(); len(got) != 0 {
		t.Fatalf("清零后再 Drain 应为空，实际 %+v", got)
	}

	meter.Record("ws-a", 5)
	samples := meter.Drain()
	if got := find(t, samples, "ws-a"); got.TrafficBytes != 5 {
		t.Fatalf("新窗口 ws-a = %d 字节，期望 5（不能累计上一个窗口）", got.TrafficBytes)
	}
}

// 零字节的请求（HEAD / 304）不计流量，但必须计一次请求数。
func TestZeroByteRequestStillCountsAsRequest(t *testing.T) {
	meter := NewMeter(0)
	meter.Record("ws-a", 0)
	meter.Record("ws-a", 0)

	got := find(t, meter.Drain(), "ws-a")
	if got.TrafficBytes != 0 {
		t.Fatalf("流量 = %d，期望 0", got.TrafficBytes)
	}
	if got.RequestCount != 2 {
		t.Fatalf("请求数 = %d，期望 2", got.RequestCount)
	}
}

// 内存必须有界：达到上界后不再新增条目，也不能把已有条目挤掉。
func TestMeterIsBounded(t *testing.T) {
	meter := NewMeter(2)
	meter.Record("ws-1", 10)
	meter.Record("ws-2", 20)
	for i := 0; i < 1000; i++ {
		meter.Record("ws-overflow", 1)
	}

	if size := meter.Size(); size != 2 {
		t.Fatalf("条目数 = %d，期望被限制在 2", size)
	}
	if dropped := meter.Dropped(); dropped != 1000 {
		t.Fatalf("丢弃计数 = %d，期望 1000", dropped)
	}
	samples := meter.Drain()
	// 已有站点的量不能因为溢出而丢失。
	if got := find(t, samples, "ws-1"); got.TrafficBytes != 10 {
		t.Fatalf("ws-1 = %+v，已有条目不应被挤掉", got)
	}
	// 上界内的站点仍能继续累加。
	meter.Record("ws-1", 5)
	if got := find(t, meter.Drain(), "ws-1"); got.TrafficBytes != 5 {
		t.Fatalf("ws-1 新窗口 = %+v", got)
	}
}

// 上报失败必须把增量并回内存，下一个窗口一起交付；ctl 抖一下不该丢掉整个窗口。
func TestFailedReportIsMergedBackAndRetried(t *testing.T) {
	meter := NewMeter(0)
	sink := &recordingSink{err: errors.New("ctl unavailable")}
	reporter := NewReporter(ReporterOptions{
		Meter:  meter,
		Sink:   sink,
		Logger: log.New(io.Discard, "", 0),
	})

	meter.Record("ws-a", 100)
	reporter.Flush(context.Background())
	if meter.Size() != 1 {
		t.Fatalf("失败后条目数 = %d，期望增量被并回内存", meter.Size())
	}

	// 下一个窗口又来了一些流量，恢复后应当一次交付两个窗口的合计。
	meter.Record("ws-a", 23)
	sink.mu.Lock()
	sink.err = nil
	sink.mu.Unlock()
	reporter.Flush(context.Background())

	batches := sink.snapshot()
	if len(batches) != 1 {
		t.Fatalf("成功交付批次数 = %d，期望 1", len(batches))
	}
	if got := find(t, batches[0], "ws-a"); got.TrafficBytes != 123 || got.RequestCount != 2 {
		t.Fatalf("重试后 ws-a = %+v，期望 123 字节 / 2 次请求", got)
	}
	if meter.Size() != 0 {
		t.Fatalf("成功交付后应清零，实际条目数 %d", meter.Size())
	}
}

// 没有流量的窗口不该产生空请求。
func TestEmptyWindowDoesNotReport(t *testing.T) {
	sink := &recordingSink{}
	reporter := NewReporter(ReporterOptions{Meter: NewMeter(0), Sink: sink, Logger: log.New(io.Discard, "", 0)})
	reporter.Flush(context.Background())
	if len(sink.snapshot()) != 0 {
		t.Fatal("空窗口不应发起上报")
	}
}

// 优雅退出必须把最后一个窗口刷出去：滚动发布远比崩溃频繁，
// 每次发布丢一个窗口的话，发布本身就成了一种系统性少计。
func TestRunFlushesOnShutdown(t *testing.T) {
	meter := NewMeter(0)
	sink := &recordingSink{}
	reporter := NewReporter(ReporterOptions{
		Meter:    meter,
		Sink:     sink,
		Interval: time.Hour, // 长到本次测试内绝不会触发 tick
		Timeout:  time.Second,
		Logger:   log.New(io.Discard, "", 0),
	})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		reporter.Run(ctx)
	}()

	meter.Record("ws-a", 42)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run 未在取消后退出")
	}

	batches := sink.snapshot()
	if len(batches) != 1 {
		t.Fatalf("退出时交付批次数 = %d，期望 1", len(batches))
	}
	if got := find(t, batches[0], "ws-a"); got.TrafficBytes != 42 {
		t.Fatalf("退出时交付的 ws-a = %+v", got)
	}
}

// 到点自动上报。
func TestRunReportsOnTick(t *testing.T) {
	meter := NewMeter(0)
	sink := &recordingSink{}
	reporter := NewReporter(ReporterOptions{
		Meter:    meter,
		Sink:     sink,
		Interval: 20 * time.Millisecond,
		Timeout:  10 * time.Millisecond,
		Logger:   log.New(io.Discard, "", 0),
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go reporter.Run(ctx)

	meter.Record("ws-a", 11)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(sink.snapshot()) > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("定时窗口未触发上报")
}

// 并发计量不能丢量也不能触发竞态（配合 -race 运行）。
func TestConcurrentRecordIsExact(t *testing.T) {
	meter := NewMeter(0)
	const goroutines, perGoroutine = 16, 200

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				meter.Record("ws-a", 3)
			}
		}()
	}
	wg.Wait()

	got := find(t, meter.Drain(), "ws-a")
	wantBytes := int64(goroutines * perGoroutine * 3)
	if got.TrafficBytes != wantBytes {
		t.Fatalf("并发累加 = %d 字节，期望 %d", got.TrafficBytes, wantBytes)
	}
	if got.RequestCount != int64(goroutines*perGoroutine) {
		t.Fatalf("并发请求数 = %d，期望 %d", got.RequestCount, goroutines*perGoroutine)
	}
}

// nil Meter 表示未启用计量，请求路径不需要判空。
func TestNilMeterIsSafe(t *testing.T) {
	var meter *Meter
	meter.Record("ws-a", 100)
	meter.MergeBack([]Sample{{SiteID: "ws-a", TrafficBytes: 1}})
	if meter.Drain() != nil || meter.Size() != 0 || meter.Dropped() != 0 {
		t.Fatal("nil Meter 的所有方法都应是空操作")
	}
}

// HTTP 上报要带内部 token，请求体要是批量结构。
func TestHTTPSinkPostsBatchWithInternalToken(t *testing.T) {
	type payload struct {
		WindowID string   `json:"window_id"`
		Reports  []Sample `json:"reports"`
	}
	var got payload
	var gotToken, gotPath string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Internal-Token")
		gotPath = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sink := NewHTTPSink(server.URL, "secret-token", server.Client())
	err := sink.Report(context.Background(), "w1", []Sample{
		{SiteID: "ws-a", TrafficBytes: 10, RequestCount: 1},
		{SiteID: "ws-b", TrafficBytes: 20, RequestCount: 2},
	})
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if gotPath != "/internal/ctl/websites/usage" {
		t.Fatalf("上报路径 = %q", gotPath)
	}
	if gotToken != "secret-token" {
		t.Fatalf("X-Internal-Token = %q", gotToken)
	}
	if len(got.Reports) != 2 || got.WindowID != "w1" {
		t.Fatalf("请求体 = %+v", got)
	}
}

// 非 2xx 必须报错，否则增量会被静默丢弃。
func TestHTTPSinkTreatsNon2xxAsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	sink := NewHTTPSink(server.URL, "", server.Client())
	if err := sink.Report(context.Background(), "w1", []Sample{{SiteID: "ws-a", TrafficBytes: 1}}); err == nil {
		t.Fatal("401 必须返回错误")
	}
}
