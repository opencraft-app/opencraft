package website

import (
	"bytes"
	"fmt"
)

// pinFullstackRelease replaces complete quoted values, never the JavaScript
// identifier with the same spelling used by the website-builder Skill.
func pinFullstackRelease(body []byte, releaseID string) ([]byte, error) {
	found := false
	for _, quote := range []string{`"`, `'`} {
		marker := []byte(quote + "__LIGHTVELA_RELEASE_ID__" + quote)
		if bytes.Contains(body, marker) {
			found = true
			body = bytes.ReplaceAll(body, marker, []byte(quote+releaseID+quote))
		}
	}
	if !found {
		return nil, fmt.Errorf("fullstack index must pin release id as a quoted value")
	}
	return body, nil
}
