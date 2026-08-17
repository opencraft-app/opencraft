package hermes

import (
	"bufio"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"velachat/agent/internal/runtimeapi"
)

func (driver *Driver) DiscoverProfileCapabilities(
	ctx context.Context,
	request runtimeapi.ProfileCapabilityRequest,
) (runtimeapi.ProfileCapabilityResult, error) {
	if strings.TrimSpace(request.AgentID) == "" ||
		strings.TrimSpace(request.WorkingDirectory) == "" {
		return runtimeapi.ProfileCapabilityResult{},
			errors.New("Hermes Profile discovery requires Agent and workspace")
	}
	host, err := driver.PrepareManagedHost(ctx, request.AgentID)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	models := discoverHermesConfiguredModels(host.ProfileHome)
	skills, err := discoverHermesProfileSkills(host.ProfileHome)
	if err != nil {
		return runtimeapi.ProfileCapabilityResult{}, err
	}
	return runtimeapi.ProfileCapabilityResult{
		Protocol:       "hermes_acp",
		RuntimeVersion: driver.version,
		ProfileHome:    host.ProfileHome,
		ProfileKind:    "hermes_managed",
		Models:         models,
		Skills:         skills,
	}, nil
}

func discoverHermesConfiguredModels(profileHome string) runtimeapi.ModelResult {
	configured := readHermesConfiguredModel(filepath.Join(profileHome, "config.yaml"))
	result := runtimeapi.ModelResult{Models: []runtimeapi.Model{}, Default: configured}
	if configured != "" {
		result.Models = append(result.Models, runtimeapi.Model{
			ID: configured, Label: configured, Verified: "configured",
		})
	}
	return result
}

func readHermesConfiguredModel(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		for _, key := range []string{"model:", "default_model:"} {
			if strings.HasPrefix(line, key) {
				return trimYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, key)))
			}
		}
	}
	return ""
}

func discoverHermesProfileSkills(profileHome string) ([]runtimeapi.Skill, error) {
	roots := []string{filepath.Join(profileHome, "skills")}
	roots = append(roots, readHermesExternalSkillRoots(
		filepath.Join(profileHome, "config.yaml"), profileHome,
	)...)
	seenRoots := make(map[string]struct{}, len(roots))
	seenSkills := make(map[string]struct{})
	skills := make([]runtimeapi.Skill, 0)
	for _, root := range roots {
		root = filepath.Clean(root)
		if _, exists := seenRoots[root]; exists {
			continue
		}
		seenRoots[root] = struct{}{}
		entries, err := os.ReadDir(root)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			directory := filepath.Join(root, entry.Name())
			info, err := os.Stat(directory)
			if err != nil || !info.IsDir() {
				continue
			}
			skill, ok := readHermesSkill(filepath.Join(directory, "SKILL.md"))
			if !ok {
				continue
			}
			if _, duplicate := seenSkills[skill.ID]; duplicate {
				continue
			}
			seenSkills[skill.ID] = struct{}{}
			skill.Path = filepath.Join(directory, "SKILL.md")
			skill.Scope = "profile"
			if !pathWithin(profileHome, directory) {
				skill.Scope = "external"
			}
			skills = append(skills, skill)
		}
	}
	sort.Slice(skills, func(i, j int) bool { return skills[i].ID < skills[j].ID })
	return skills, nil
}

func readHermesSkill(path string) (runtimeapi.Skill, bool) {
	file, err := os.Open(path)
	if err != nil {
		return runtimeapi.Skill{}, false
	}
	defer file.Close()
	name := ""
	description := ""
	scanner := bufio.NewScanner(file)
	inFrontmatter := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "---" {
			if inFrontmatter {
				break
			}
			inFrontmatter = true
			continue
		}
		if !inFrontmatter {
			continue
		}
		if strings.HasPrefix(line, "name:") {
			name = trimYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, "name:")))
		}
		if strings.HasPrefix(line, "description:") {
			description = trimYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, "description:")))
		}
	}
	if name == "" {
		return runtimeapi.Skill{}, false
	}
	return runtimeapi.Skill{
		ID: name, Name: name, Description: description, Enabled: true,
		Availability: "available", MissingDependencyTypes: []string{},
	}, true
}

func readHermesExternalSkillRoots(configPath string, profileHome string) []string {
	file, err := os.Open(configPath)
	if err != nil {
		return nil
	}
	defer file.Close()
	result := make([]string, 0)
	inList := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		raw := strings.SplitN(scanner.Text(), "#", 2)[0]
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "skill_paths:") ||
			strings.HasPrefix(trimmed, "skills_dirs:") ||
			strings.HasPrefix(trimmed, "external_skills:") {
			inList = true
			if value := strings.TrimSpace(strings.SplitN(trimmed, ":", 2)[1]); value != "" {
				for _, item := range strings.Split(strings.Trim(value, "[]"), ",") {
					result = appendSkillRoot(result, item, profileHome)
				}
			}
			continue
		}
		if inList && strings.HasPrefix(trimmed, "-") {
			result = appendSkillRoot(result, strings.TrimPrefix(trimmed, "-"), profileHome)
			continue
		}
		if len(raw) == len(strings.TrimLeft(raw, " \t")) {
			inList = false
		}
	}
	return result
}

func appendSkillRoot(result []string, raw string, profileHome string) []string {
	value := trimYAMLScalar(strings.TrimSpace(raw))
	if value == "" {
		return result
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(profileHome, value)
	}
	return append(result, filepath.Clean(value))
}

func trimYAMLScalar(value string) string {
	return strings.Trim(strings.TrimSpace(value), `"'`)
}

func pathWithin(root string, path string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	return err == nil && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
