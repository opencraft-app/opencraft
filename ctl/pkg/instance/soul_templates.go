package instance

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

const sandboxSoulTargetPath = "${HOME}/.openclaw/workspace/SOUL.md"

func resolveRequestedSoulTemplateID(req string) (string, error) {
	req = strings.TrimSpace(req)
	defaultID := ""
	if conf := currentInstanceAPIConfig(); conf != nil {
		defaultID = strings.TrimSpace(conf.DefaultSoulTemplateID)
	}
	if req == "" {
		return defaultID, nil
	}
	if !isValidSoulTemplateID(req) {
		return "", errcode.Wrap(errcode.ErrInstanceInvalidParam, "invalid soul_template_id")
	}
	return req, nil
}

func isValidSoulTemplateID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

func loadSoulTemplateContent(templateID string) (string, error) {
	templateID = strings.TrimSpace(templateID)
	if templateID == "" {
		return "", nil
	}
	if !isValidSoulTemplateID(templateID) {
		return "", fmt.Errorf("invalid soul template id %q", templateID)
	}
	templateDir := ""
	if conf := currentInstanceAPIConfig(); conf != nil {
		templateDir = strings.TrimSpace(conf.SoulTemplateDir)
	}
	if templateDir == "" {
		return "", fmt.Errorf("soul template dir not configured")
	}
	path := filepath.Join(templateDir, "SOUL-"+templateID+".md")
	content, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", errcode.Wrap(errcode.ErrInstanceInvalidParam, "unknown soul_template_id %q", templateID)
		}
		return "", fmt.Errorf("read soul template %s: %w", templateID, err)
	}
	return string(content), nil
}

func availableSoulTemplateIDs() ([]string, error) {
	templateDir := ""
	if conf := currentInstanceAPIConfig(); conf != nil {
		templateDir = strings.TrimSpace(conf.SoulTemplateDir)
	}
	if templateDir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(templateDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "SOUL-") || !strings.HasSuffix(name, ".md") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimPrefix(name, "SOUL-"), ".md")
		if !isValidSoulTemplateID(id) {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func listSoulTemplates() ([]*transport.SoulTemplateResponse, error) {
	ids, err := availableSoulTemplateIDs()
	if err != nil {
		return nil, err
	}
	items := make([]*transport.SoulTemplateResponse, 0, len(ids))
	for _, id := range ids {
		meta, err := readSoulTemplateMetadata(id)
		if err != nil {
			return nil, err
		}
		items = append(items, &transport.SoulTemplateResponse{
			ID:          id,
			Name:        meta.Name,
			Description: meta.Description,
		})
	}
	return items, nil
}

type soulTemplateMeta struct {
	Name        string
	Description string
}

func readSoulTemplateMetadata(id string) (soulTemplateMeta, error) {
	content, err := loadSoulTemplateContent(id)
	if err != nil {
		return soulTemplateMeta{}, err
	}
	meta := soulTemplateMeta{
		Name:        id,
		Description: "Custom soul template.",
	}
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if meta.Name == id && strings.HasPrefix(line, "# ") {
			meta.Name = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			meta.Name = strings.TrimSpace(strings.TrimPrefix(meta.Name, "SOUL.md —"))
			meta.Name = strings.TrimSpace(strings.TrimPrefix(meta.Name, "SOUL.md -"))
			meta.Name = strings.TrimSpace(strings.TrimPrefix(meta.Name, "SOUL.md --"))
			meta.Name = strings.Trim(meta.Name, " -")
			meta.Name = strings.Trim(meta.Name, "— ")
			continue
		}
		if strings.HasPrefix(line, "_") {
			meta.Description = strings.Trim(strings.TrimSpace(line), "_")
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return soulTemplateMeta{}, fmt.Errorf("scan soul template %s: %w", id, err)
	}
	return meta, nil
}

func renderSandboxSoulWriteCommand(content string) string {
	return strings.Join([]string{
		`mkdir -p "${HOME}/.openclaw/workspace"`,
		`cat <<'__CTL_SOUL_EOF__' > "${HOME}/.openclaw/workspace/SOUL.md"`,
		strings.TrimRight(content, "\n"),
		`__CTL_SOUL_EOF__`,
	}, "\n")
}
