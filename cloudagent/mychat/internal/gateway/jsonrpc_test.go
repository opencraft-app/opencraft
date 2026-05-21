package gateway

import "testing"

func TestParseJSONRPCRejectsMalformedShapes(t *testing.T) {
	for _, input := range []string{
		`{"jsonrpc":"2.0","id":1}`,
		`{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1}}`,
		`{"jsonrpc":"2.0","method":"initialize","result":{}}`,
	} {
		if _, err := parseJSONRPC([]byte(input)); err == nil {
			t.Fatalf("expected malformed JSON-RPC to fail: %s", input)
		}
	}
}

func TestParseJSONRPCAcceptsRequestsNotificationsAndResponses(t *testing.T) {
	for _, input := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"session/cancel","params":{}}`,
		`{"jsonrpc":"2.0","id":1,"result":{}}`,
		`{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"missing"}}`,
	} {
		if _, err := parseJSONRPC([]byte(input)); err != nil {
			t.Fatalf("expected valid JSON-RPC to pass: %s: %v", input, err)
		}
	}
}
