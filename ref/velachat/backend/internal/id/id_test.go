package id

import (
	"regexp"
	"strings"
	"sync"
	"testing"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestNew生成标准小写UUIDv7(t *testing.T) {
	got, err := New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if !uuidPattern.MatchString(got) {
		t.Fatalf("New() = %q，不是标准 UUIDv7", got)
	}
	if got != strings.ToLower(got) {
		t.Fatalf("New() = %q，不是小写", got)
	}
}

func TestNew并发生成不重复(t *testing.T) {
	const workers = 20
	const perWorker = 500

	ids := make(chan string, workers*perWorker)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for range workers {
		go func() {
			defer wg.Done()
			for range perWorker {
				value, err := New()
				if err != nil {
					errs <- err
					return
				}
				ids <- value
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)

	for err := range errs {
		t.Fatalf("New() error = %v", err)
	}
	seen := make(map[string]struct{}, workers*perWorker)
	for value := range ids {
		if _, ok := seen[value]; ok {
			t.Fatalf("发现重复 UUID：%s", value)
		}
		seen[value] = struct{}{}
	}
	if got, want := len(seen), workers*perWorker; got != want {
		t.Fatalf("生成数量 = %d，期望 %d", got, want)
	}
}
