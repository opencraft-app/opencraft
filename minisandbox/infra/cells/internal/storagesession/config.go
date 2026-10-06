// Package storagesession renews three UID-pinned, Cell-owned storage Secrets.
package storagesession

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/util/validation"
)

const STSEndpoint = "sts.internal.tencentcloudapi.com"

// Config contains public identities only. Never put JWTs or cloud keys here.
type Config struct {
	Namespace             string `json:"namespace"`
	NamespaceUID          string `json:"namespaceUID"`
	CellName              string `json:"cellName"`
	CellUID               string `json:"cellUID"`
	LeaseName             string `json:"leaseName"`
	LeaseUID              string `json:"leaseUID"`
	ManagedBy             string `json:"managedBy"`
	Region                string `json:"region"`
	ProviderID            string `json:"providerID"`
	Audience              string `json:"audience"`
	ServiceAccount        string `json:"serviceAccount"`
	TokenFile             string `json:"tokenFile"`
	STSEndpoint           string `json:"stsEndpoint"`
	Roles                 []Role `json:"roles"`
	DurationSeconds       int64  `json:"durationSeconds"`
	PollSeconds           int64  `json:"pollSeconds"`
	RenewBeforeSeconds    int64  `json:"renewBeforeSeconds"`
	ReadyMinSeconds       int64  `json:"readyMinSeconds"`
	RequestTimeoutSeconds int64  `json:"requestTimeoutSeconds"`
}

type Role struct {
	Name       string `json:"name"`
	ARN        string `json:"roleARN"`
	SecretName string `json:"secretName"`
	SecretUID  string `json:"secretUID"`
	// BackupHost is the exact COS host, without scheme or the FDB '@' prefix.
	BackupHost string `json:"backupHost,omitempty"`
}

func LoadConfig(path string) (Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return Config{}, errors.New("config_unavailable")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 32769))
	if err != nil || len(b) > 32768 {
		return Config{}, errors.New("config_invalid")
	}
	var c Config
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || d.Decode(new(any)) != io.EOF {
		return Config{}, errors.New("config_invalid")
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	bad := errors.New("config_invalid")
	for _, v := range []string{c.Namespace, c.CellName, c.LeaseName, c.ServiceAccount} {
		if len(validation.IsDNS1123Subdomain(v)) != 0 {
			return bad
		}
	}
	if c.NamespaceUID == "" || c.CellUID == "" || c.LeaseUID == "" || c.ManagedBy == "" ||
		c.Region == "" || c.ProviderID == "" || c.Audience == "" || !filepath.IsAbs(c.TokenFile) || c.STSEndpoint != STSEndpoint {
		return bad
	}
	if c.DurationSeconds < 900 || c.DurationSeconds > 3600 || c.PollSeconds < 5 || c.PollSeconds > 120 ||
		c.RequestTimeoutSeconds < 1 || c.RequestTimeoutSeconds > 10 || c.ReadyMinSeconds < 60 || c.ReadyMinSeconds > 600 ||
		c.RenewBeforeSeconds <= c.ReadyMinSeconds+3*c.RequestTimeoutSeconds+c.PollSeconds ||
		c.RenewBeforeSeconds >= c.DurationSeconds-2*c.RequestTimeoutSeconds || len(c.Roles) != 3 {
		return bad
	}
	names, secrets, uids, arns := map[string]bool{}, map[string]bool{}, map[string]bool{}, map[string]bool{}
	arn := regexp.MustCompile(`^qcs::cam::uin/[0-9]+:role/[A-Za-z0-9_-]+$`)
	for _, r := range c.Roles {
		if (r.Name != "cold" && r.Name != "code" && r.Name != "backup") || names[r.Name] || secrets[r.SecretName] || uids[r.SecretUID] || arns[r.ARN] ||
			!arn.MatchString(r.ARN) || r.SecretUID == "" || len(validation.IsDNS1123Subdomain(r.SecretName)) != 0 {
			return bad
		}
		if r.Name == "backup" {
			suffix := ".cos." + c.Region + ".myqcloud.com"
			if !strings.HasSuffix(r.BackupHost, suffix) || r.BackupHost == suffix || len(validation.IsDNS1123Subdomain(r.BackupHost)) != 0 {
				return bad
			}
		} else if r.BackupHost != "" {
			return bad
		}
		names[r.Name], secrets[r.SecretName], uids[r.SecretUID], arns[r.ARN] = true, true, true, true
	}
	return nil
}

func (c Config) timeout() time.Duration { return time.Duration(c.RequestTimeoutSeconds) * time.Second }
