package state

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

const userSessionPath = "computer/user-session.json"

var serverIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

type UserSession struct {
	SchemaVersion int       `json:"schemaVersion"`
	ServerURL     string    `json:"serverUrl"`
	AccessToken   string    `json:"accessToken"`
	RefreshToken  string    `json:"refreshToken"`
	UserID        string    `json:"userId"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func (s *Store) SaveUserSession(session UserSession) error {
	return s.Write(userSessionPath, session)
}

func (s *Store) LoadUserSession() (UserSession, error) {
	var session UserSession
	if err := s.Read(userSessionPath, &session); err != nil {
		return UserSession{}, err
	}
	return session, nil
}

type RunnerState struct {
	SchemaVersion   int    `json:"schemaVersion"`
	ServerID        string `json:"serverId"`
	ServerSlug      string `json:"serverSlug"`
	ServerURL       string `json:"serverUrl"`
	ServerMachineID string `json:"serverMachineId"`
	MachineID       string `json:"machineId,omitempty"`
	APIKey          string `json:"apiKey"`
}

func (s *Store) SaveRunnerState(runner RunnerState) error {
	if !validServerID(runner.ServerID) {
		return errors.New("runner state server ID is invalid")
	}
	return s.Write(runnerStatePath(runner.ServerID), runner)
}

func (s *Store) LoadRunnerState(serverID string) (RunnerState, error) {
	if !validServerID(serverID) {
		return RunnerState{}, errors.New("runner state server ID is invalid")
	}
	var runner RunnerState
	if err := s.Read(runnerStatePath(serverID), &runner); err != nil {
		return RunnerState{}, err
	}
	return runner, nil
}

func (s *Store) ListRunnerStates() ([]RunnerState, error) {
	directory := filepath.Join(s.root, "computer", "servers")
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return []RunnerState{}, nil
	}
	if err != nil {
		return nil, err
	}
	runners := make([]RunnerState, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validServerID(entry.Name()) {
			continue
		}
		runner, err := s.LoadRunnerState(entry.Name())
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		runners = append(runners, runner)
	}
	sort.Slice(runners, func(left, right int) bool {
		return runners[left].ServerID < runners[right].ServerID
	})
	return runners, nil
}

func runnerStatePath(serverID string) string {
	return filepath.Join("computer", "servers", serverID, "runner.state.json")
}

func validServerID(serverID string) bool {
	return serverIDPattern.MatchString(serverID) && serverID != "." && serverID != ".."
}
