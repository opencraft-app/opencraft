package internalapi

import (
	"context"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"git.woa.com/wisp/mono/trade/internal/personaldevbilling"
)

const personalDevBillingProxyMaxBody = int64(1 << 20)

type personalDevBillingForwarder interface {
	Forward(context.Context, string, string, string, string, http.Header, []byte) (*personaldevbilling.Response, error)
}

func personalDevBillingProxyHandler(proxy personalDevBillingForwarder) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		body, err := io.ReadAll(io.LimitReader(ctx.Request.Body, personalDevBillingProxyMaxBody+1))
		if err != nil || int64(len(body)) > personalDevBillingProxyMaxBody {
			ctx.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": "RequestTooLarge", "message": "billing proxy request body is too large"})
			return
		}
		response, err := proxy.Forward(
			ctx.Request.Context(),
			ctx.Param("kind"),
			ctx.Param("path"),
			ctx.Request.URL.RawQuery,
			strings.TrimSpace(ctx.GetHeader(personaldevbilling.DeveloperUINHeader)),
			ctx.Request.Header.Clone(),
			body,
		)
		if err != nil {
			ctx.JSON(http.StatusBadGateway, gin.H{"code": "PersonalDevBillingProxyFailed", "message": "testing billing proxy request failed"})
			return
		}
		if value := strings.TrimSpace(response.Header.Get("Content-Type")); value != "" {
			ctx.Header("Content-Type", value)
		}
		for _, name := range []string{"X-QCloud-Transaction-ID", "X-Request-ID"} {
			if value := strings.TrimSpace(response.Header.Get(name)); value != "" {
				ctx.Header(name, value)
			}
		}
		ctx.Data(response.StatusCode, response.Header.Get("Content-Type"), response.Body)
	}
}
