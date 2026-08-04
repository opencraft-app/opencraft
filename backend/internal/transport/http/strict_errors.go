package httptransport

import (
	"net/http"

	"chatserver/internal/api/openapi"
)

// StdHTTPErrorHandler 覆盖生成路由器默认的纯文本绑定错误。
func StdHTTPErrorHandler(
	encoder *ErrorEncoder,
) func(http.ResponseWriter, *http.Request, error) {
	return func(writer http.ResponseWriter, request *http.Request, err error) {
		encoder.WriteCode(
			writer,
			requestIDFromRequest(request),
			"invalid_request",
			err,
		)
	}
}

// StrictServerOptions 覆盖 strict handler 默认的纯文本 request/response 错误。
func StrictServerOptions(encoder *ErrorEncoder) openapi.StrictHTTPServerOptions {
	return openapi.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(
			writer http.ResponseWriter,
			request *http.Request,
			err error,
		) {
			encoder.WriteCode(
				writer,
				requestIDFromRequest(request),
				"invalid_request",
				err,
			)
		},
		ResponseErrorHandlerFunc: func(
			writer http.ResponseWriter,
			request *http.Request,
			err error,
		) {
			encoder.Write(
				writer,
				requestIDFromRequest(request),
				err,
			)
		},
	}
}
