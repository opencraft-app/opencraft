package client

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

	"golang.org/x/term"
)

type Config struct {
	TargetURL string
	Username  string
	Password  string
}

func ParseConfig(args []string, getenv func(string) string) (Config, error) {
	fs := flag.NewFlagSet("nextgen-dashboard-client", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	defaultURL := strings.TrimSpace(getenv("NEXTGEN_DASHBOARD_CLIENT_URL"))
	if defaultURL == "" {
		defaultURL = "https://lightclaw.tech/admin"
	}
	defaultUsername := strings.TrimSpace(getenv("NEXTGEN_DASHBOARD_CLIENT_USERNAME"))
	defaultPassword := strings.TrimSpace(getenv("NEXTGEN_DASHBOARD_CLIENT_PASSWORD"))

	var config Config
	fs.StringVar(&config.TargetURL, "url", defaultURL, "nextgen dashboard admin URL or websocket URL")
	fs.StringVar(&config.Username, "username", defaultUsername, "HTTP Basic Auth username")
	fs.StringVar(&config.Password, "password", defaultPassword, "HTTP Basic Auth password")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if strings.TrimSpace(config.Username) == "" {
		return Config{}, errors.New("username is required")
	}
	if strings.TrimSpace(config.Password) == "" {
		if term.IsTerminal(int(os.Stdin.Fd())) {
			fmt.Fprint(os.Stderr, "Password: ")
			passwordBytes, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			if err != nil {
				return Config{}, fmt.Errorf("read password: %w", err)
			}
			config.Password = strings.TrimSpace(string(passwordBytes))
		}
		if strings.TrimSpace(config.Password) == "" {
			return Config{}, errors.New("password is required")
		}
	}
	if strings.TrimSpace(config.TargetURL) == "" {
		return Config{}, errors.New("url is required")
	}
	return config, nil
}

func ResolveWebSocketURL(raw string) (string, error) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("parse target url: %w", err)
	}
	switch target.Scheme {
	case "ws", "wss":
		return target.String(), nil
	case "http", "https":
		if strings.HasSuffix(target.Path, "/ws/terminal") {
			target.Scheme = map[string]string{"http": "ws", "https": "wss"}[target.Scheme]
			return target.String(), nil
		}
		target.Scheme = map[string]string{"http": "ws", "https": "wss"}[target.Scheme]
		target.Path = strings.TrimRight(target.Path, "/") + "/ws/terminal"
		target.RawQuery = ""
		target.Fragment = ""
		return target.String(), nil
	default:
		return "", fmt.Errorf("unsupported url scheme %q", target.Scheme)
	}
}

func BuildAuthorizationHeader(username string, password string) string {
	token := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
	return "Basic " + token
}
