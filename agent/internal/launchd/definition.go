package launchd

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const definitionFingerprintEnvironmentKey = "LAUNCHD_AGENT_DEFINITION_SHA256"

var (
	ErrInvalidDefinition = errors.New("invalid launchd definition")
	ErrInvalidDirectory  = errors.New("invalid LaunchAgents directory")
	ErrIdentityMismatch  = errors.New("loaded launchd identity does not match definition")
	validLabel           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	validEnvironmentKey  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

type ProcessType string

const (
	ProcessTypeBackground  ProcessType = "Background"
	ProcessTypeInteractive ProcessType = "Interactive"
	ProcessTypeAdaptive    ProcessType = "Adaptive"
	ProcessTypeStandard    ProcessType = "Standard"
)

type Definition struct {
	Label         string
	Program       string
	ProgramSHA256 string
	Arguments     []string
	StdoutPath    string
	StderrPath    string
	Environment   map[string]string
	KeepAlive     bool
	RunAtLoad     bool
	ProcessType   ProcessType
	Umask         uint32
}

func validateDefinition(definition Definition) error {
	if !validLabel.MatchString(definition.Label) || strings.Contains(definition.Label, "..") ||
		!validAbsolutePath(definition.Program) ||
		!validAbsolutePath(definition.StdoutPath) ||
		!validAbsolutePath(definition.StderrPath) ||
		len(definition.ProgramSHA256) != sha256.Size*2 || definition.Umask > 0o777 {
		return ErrInvalidDefinition
	}
	if decoded, err := hex.DecodeString(definition.ProgramSHA256); err != nil ||
		len(decoded) != sha256.Size || definition.ProgramSHA256 != strings.ToLower(definition.ProgramSHA256) {
		return ErrInvalidDefinition
	}
	switch definition.ProcessType {
	case ProcessTypeBackground, ProcessTypeInteractive, ProcessTypeAdaptive, ProcessTypeStandard:
	default:
		return ErrInvalidDefinition
	}
	for _, argument := range definition.Arguments {
		if strings.ContainsRune(argument, 0) {
			return ErrInvalidDefinition
		}
	}
	for key, value := range definition.Environment {
		if key == definitionFingerprintEnvironmentKey || !validEnvironmentKey.MatchString(key) ||
			strings.ContainsRune(value, 0) {
			return ErrInvalidDefinition
		}
	}
	return nil
}

func validAbsolutePath(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && !strings.ContainsRune(value, 0)
}

func definitionFingerprint(definition Definition) (string, error) {
	if err := validateDefinition(definition); err != nil {
		return "", err
	}
	var canonical bytes.Buffer
	writeFingerprintString(&canonical, "label")
	writeFingerprintString(&canonical, definition.Label)
	writeFingerprintString(&canonical, "program")
	writeFingerprintString(&canonical, definition.Program)
	writeFingerprintString(&canonical, "program_sha256")
	writeFingerprintString(&canonical, definition.ProgramSHA256)
	writeFingerprintString(&canonical, "arguments")
	_ = binary.Write(&canonical, binary.BigEndian, uint64(len(definition.Arguments)))
	for _, argument := range definition.Arguments {
		writeFingerprintString(&canonical, argument)
	}
	writeFingerprintString(&canonical, "stdout")
	writeFingerprintString(&canonical, definition.StdoutPath)
	writeFingerprintString(&canonical, "stderr")
	writeFingerprintString(&canonical, definition.StderrPath)
	keys := make([]string, 0, len(definition.Environment))
	for key := range definition.Environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	writeFingerprintString(&canonical, "environment")
	_ = binary.Write(&canonical, binary.BigEndian, uint64(len(keys)))
	for _, key := range keys {
		writeFingerprintString(&canonical, key)
		writeFingerprintString(&canonical, definition.Environment[key])
	}
	writeFingerprintString(&canonical, "keep_alive")
	if definition.KeepAlive {
		canonical.WriteByte(1)
	} else {
		canonical.WriteByte(0)
	}
	writeFingerprintString(&canonical, "run_at_load")
	if definition.RunAtLoad {
		canonical.WriteByte(1)
	} else {
		canonical.WriteByte(0)
	}
	writeFingerprintString(&canonical, "process_type")
	writeFingerprintString(&canonical, string(definition.ProcessType))
	writeFingerprintString(&canonical, "umask")
	_ = binary.Write(&canonical, binary.BigEndian, definition.Umask)
	digest := sha256.Sum256(canonical.Bytes())
	return hex.EncodeToString(digest[:]), nil
}

func writeFingerprintString(output *bytes.Buffer, value string) {
	_ = binary.Write(output, binary.BigEndian, uint64(len(value)))
	output.WriteString(value)
}

func renderDefinition(definition Definition) ([]byte, error) {
	fingerprint, err := definitionFingerprint(definition)
	if err != nil {
		return nil, err
	}
	var output bytes.Buffer
	output.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>`)
	writeXMLPair(&output, "Label", definition.Label)
	output.WriteString("<key>ProgramArguments</key><array>")
	writeXMLString(&output, definition.Program)
	for _, argument := range definition.Arguments {
		writeXMLString(&output, argument)
	}
	output.WriteString("</array>")
	writeXMLPair(&output, "StandardOutPath", definition.StdoutPath)
	writeXMLPair(&output, "StandardErrorPath", definition.StderrPath)
	writeXMLBool(&output, "RunAtLoad", definition.RunAtLoad)
	writeXMLBool(&output, "KeepAlive", definition.KeepAlive)
	writeXMLPair(&output, "ProcessType", string(definition.ProcessType))
	output.WriteString("<key>Umask</key><integer>")
	output.WriteString(strconv.FormatUint(uint64(definition.Umask), 10))
	output.WriteString("</integer><key>EnvironmentVariables</key><dict>")
	environment := make(map[string]string, len(definition.Environment)+1)
	for key, value := range definition.Environment {
		environment[key] = value
	}
	environment[definitionFingerprintEnvironmentKey] = fingerprint
	keys := make([]string, 0, len(environment))
	for key := range environment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		writeXMLPair(&output, key, environment[key])
	}
	output.WriteString("</dict></dict></plist>\n")
	return output.Bytes(), nil
}

func writeXMLPair(output *bytes.Buffer, key, value string) {
	output.WriteString("<key>")
	_ = xml.EscapeText(output, []byte(key))
	output.WriteString("</key>")
	writeXMLString(output, value)
}

func writeXMLString(output *bytes.Buffer, value string) {
	output.WriteString("<string>")
	_ = xml.EscapeText(output, []byte(value))
	output.WriteString("</string>")
}

func writeXMLBool(output *bytes.Buffer, key string, value bool) {
	output.WriteString("<key>")
	_ = xml.EscapeText(output, []byte(key))
	if value {
		output.WriteString("</key><true/>")
	} else {
		output.WriteString("</key><false/>")
	}
}
