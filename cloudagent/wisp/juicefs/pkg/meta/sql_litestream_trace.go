//go:build litestreamvfs && vfs

package meta

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"
)

func sqliteLitestreamTraceEnabled() bool {
	for _, name := range []string{"JFS_LITESTREAM_TRACE", "SMH_HTTP_TRACE", "COS_HTTP_TRACE"} {
		v := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
		if v == "1" || v == "true" || v == "yes" || v == "on" {
			return true
		}
	}
	return false
}

func sqliteLitestreamTrace(event string, attrs ...any) {
	if !sqliteLitestreamTraceEnabled() {
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "sqlite_litestream_trace ts=%s event=%s pid=%d", time.Now().UTC().Format(time.RFC3339Nano), event, os.Getpid())
	for i := 0; i+1 < len(attrs); i += 2 {
		fmt.Fprintf(&b, " %s=%q", attrs[i], fmt.Sprint(attrs[i+1]))
	}
	fmt.Fprintf(&b, " stack=%q\n", sqliteLitestreamTraceStack(3))
	_, _ = os.Stderr.WriteString(b.String())
}

func sqliteLitestreamTraceStack(skip int) string {
	pcs := make([]uintptr, 24)
	n := runtime.Callers(skip, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	var names []string
	for {
		frame, more := frames.Next()
		name := shortenLitestreamTraceFunction(frame.Function)
		if name != "" {
			names = append(names, name)
		}
		if !more || len(names) >= 8 {
			break
		}
	}
	return strings.Join(names, "<-")
}

func shortenLitestreamTraceFunction(name string) string {
	switch {
	case strings.Contains(name, "github.com/juicedata/juicefs/pkg/meta."):
		name = strings.TrimPrefix(name, "github.com/juicedata/juicefs/pkg/meta.")
	case strings.Contains(name, "github.com/benbjohnson/litestream."):
		name = strings.TrimPrefix(name, "github.com/benbjohnson/litestream.")
	case strings.Contains(name, "database/sql."):
		name = strings.TrimPrefix(name, "database/sql.")
	default:
		return ""
	}
	name = strings.TrimPrefix(name, "(*")
	name = strings.ReplaceAll(name, ")", "")
	return name
}
