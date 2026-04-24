// Package tracing ...
package tracing

import (
	"context"
	"crypto/rand"
	"crypto/sha256"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"

	pcontext "ctl/pkg/context"
)

type traceIdGenerator struct {
}

// NewIDs ...
func (i *traceIdGenerator) NewIDs(ctx context.Context) (trace.TraceID, trace.SpanID) {
	rid := ""
	if reqCtx, ok := ctx.(pcontext.Context); ok && reqCtx != nil {
		rid = reqCtx.GetRequestId()
	}

	tid := trace.TraceID{}
	switch {
	case rid == "":
		_, _ = rand.Read(tid[:])
	case isUUIDRequestID(rid):
		uid := uuid.MustParse(rid)
		copy(tid[:], uid[:])
	default:
		sum := sha256.Sum256([]byte(rid))
		copy(tid[:], sum[:len(tid)])
	}

	return tid, i.NewSpanID(ctx, tid)
}

func isUUIDRequestID(rid string) bool {
	_, err := uuid.Parse(rid)
	return err == nil
}

// NewSpanID ...
func (i *traceIdGenerator) NewSpanID(ctx context.Context, traceID trace.TraceID) trace.SpanID {
	sid := trace.SpanID{}
	_, _ = rand.Read(sid[:])

	return sid
}
