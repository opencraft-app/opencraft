package service

import (
	"encoding/csv"
	"errors"
	"io"
	"regexp"
	"strings"

	_ "embed"
)

//go:embed registration_email_suffix_blacklist.csv
var embeddedRegistrationEmailSuffixBlacklistCSV string

var (
	defaultRegistrationEmailSuffixBlacklist = mustLoadRegistrationEmailSuffixBlacklist(embeddedRegistrationEmailSuffixBlacklistCSV)
	registrationEmailSuffixPattern          = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
)

type registrationEmailSuffixBlacklist struct {
	suffixes []string
}

func mustLoadRegistrationEmailSuffixBlacklist(rawCSV string) registrationEmailSuffixBlacklist {
	blacklist, err := loadRegistrationEmailSuffixBlacklist(rawCSV)
	if err != nil {
		panic(err)
	}
	return blacklist
}

func loadRegistrationEmailSuffixBlacklist(rawCSV string) (registrationEmailSuffixBlacklist, error) {
	reader := csv.NewReader(strings.NewReader(rawCSV))
	reader.FieldsPerRecord = -1
	reader.TrimLeadingSpace = true

	var values []string
	for rowNumber := 1; ; rowNumber++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return registrationEmailSuffixBlacklist{}, err
		}
		if len(record) == 0 {
			continue
		}

		value := strings.TrimPrefix(strings.TrimSpace(record[0]), "\ufeff")
		if value == "" {
			continue
		}
		if rowNumber == 1 && strings.EqualFold(value, "data_content") {
			continue
		}
		values = append(values, value)
	}
	return newRegistrationEmailSuffixBlacklist(values), nil
}

func newRegistrationEmailSuffixBlacklist(values []string) registrationEmailSuffixBlacklist {
	blacklist := registrationEmailSuffixBlacklist{suffixes: make([]string, 0, len(values))}
	for _, value := range values {
		if suffix := normalizeRegistrationEmailSuffix(value); suffix != "" {
			blacklist.suffixes = append(blacklist.suffixes, suffix)
		}
	}
	return blacklist
}

func (b registrationEmailSuffixBlacklist) blocksEmail(email string) bool {
	domain := emailDomain(email)
	if domain == "" {
		return false
	}
	for _, suffix := range b.suffixes {
		if domain == suffix || strings.HasSuffix(domain, "."+suffix) {
			return true
		}
	}
	return false
}

func emailDomain(email string) string {
	normalized := normalizeEmail(email)
	at := strings.LastIndex(normalized, "@")
	if at < 0 || at == len(normalized)-1 {
		return ""
	}
	return strings.Trim(normalized[at+1:], ".")
}

func normalizeRegistrationEmailSuffix(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, "\ufeff")))
	if at := strings.LastIndex(normalized, "@"); at >= 0 {
		normalized = normalized[at+1:]
	}
	normalized = strings.Trim(normalized, ".")
	if normalized == "" || !registrationEmailSuffixPattern.MatchString(normalized) {
		return ""
	}
	return normalized
}

func registrationEmailSuffixBlockedError() *Error {
	return newError("registration_email_suffix_blocked", "该邮箱后缀暂不支持注册，请更换邮箱。", 403)
}

func oauthRegistrationEmailRequiredError() *Error {
	return newError("oauth_registration_email_required", "GitHub 账号需要提供已验证邮箱后才能注册。", 403)
}

func enforceOAuthNewUserRegistrationEmailPolicy(input OAuthSignInInput) error {
	if input.RegistrationEmailRequired && strings.TrimSpace(input.Email) == "" {
		return oauthRegistrationEmailRequiredError()
	}
	if input.RegistrationEmailSuffixBlocked {
		return registrationEmailSuffixBlockedError()
	}
	return nil
}
