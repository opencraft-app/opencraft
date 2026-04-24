package runner

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/gorilla/websocket"
)

type Client struct {
	conn *websocket.Conn
}

func Dial(rawURL string, bearerToken string) (*Client, error) {
	return DialWithHeaders(rawURL, bearerToken, nil)
}

func DialWithHeaders(rawURL string, bearerToken string, extraHeaders http.Header) (*Client, error) {
	headers := http.Header{}
	for key, values := range extraHeaders {
		for _, value := range values {
			headers.Add(key, value)
		}
	}
	if strings.TrimSpace(bearerToken) != "" {
		headers.Set("Authorization", "Bearer "+strings.TrimSpace(bearerToken))
	}

	target := strings.TrimSpace(rawURL)
	if target == "" {
		target = "ws://127.0.0.1:19091/ws/shell"
	}
	if _, err := url.Parse(target); err != nil {
		return nil, err
	}
	conn, _, err := websocket.DefaultDialer.Dial(target, headers)
	if err != nil {
		return nil, err
	}
	return &Client{conn: conn}, nil
}

func (c *Client) ReadJSON(v any) error {
	return c.conn.ReadJSON(v)
}

func (c *Client) WriteJSON(v any) error {
	return c.conn.WriteJSON(v)
}

func (c *Client) Close() error {
	return c.conn.Close()
}
