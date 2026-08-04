package hermes

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"velachat/agent/internal/state"
)

const (
	profileTransactionSchema = 1
)

type profileTransactionPhase string

const (
	profileTransactionPlanned       profileTransactionPhase = "planned"
	profileTransactionNativeCreated profileTransactionPhase = "native_created"
	profileTransactionScrubbed      profileTransactionPhase = "scrubbed"
	profileTransactionCommitted     profileTransactionPhase = "committed"
)

type managedProfileTransaction struct {
	Schema        int                     `json:"schema"`
	TransactionID string                  `json:"transactionId"`
	AgentID       string                  `json:"agentId"`
	ProfileName   string                  `json:"profileName"`
	ProfileHome   string                  `json:"profileHome"`
	TemplateHome  string                  `json:"templateHome"`
	Phase         profileTransactionPhase `json:"phase"`
	CreatedAt     time.Time               `json:"createdAt"`
}

func (p *nativeProfileProvisioner) newTransaction(
	agentID string,
	selection profileSelection,
) (managedProfileTransaction, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return managedProfileTransaction{}, err
	}
	return managedProfileTransaction{
		Schema:        profileTransactionSchema,
		TransactionID: hex.EncodeToString(random),
		AgentID:       agentID,
		ProfileName:   selection.Name,
		ProfileHome:   selection.Home,
		TemplateHome:  filepath.Join(p.trustedHome, ".hermes"),
		Phase:         profileTransactionPlanned,
		CreatedAt:     p.now().UTC(),
	}, nil
}

func (p *nativeProfileProvisioner) transactionStore() *state.Store {
	return state.New(
		filepath.Join(p.trustedHome, ".hermes", ".vela-computer"),
	)
}

func (p *nativeProfileProvisioner) transactionRelativePath(
	profileName string,
) string {
	return filepath.Join("profile-transactions", profileName+".json")
}

func (p *nativeProfileProvisioner) transactionPath(
	profileName string,
) string {
	return filepath.Join(
		p.trustedHome,
		".hermes",
		".vela-computer",
		p.transactionRelativePath(profileName),
	)
}

func (p *nativeProfileProvisioner) writeTransaction(
	transaction managedProfileTransaction,
) error {
	if err := p.validateTransaction(transaction); err != nil {
		return err
	}
	return p.transactionStore().Write(
		p.transactionRelativePath(transaction.ProfileName),
		transaction,
	)
}

func (p *nativeProfileProvisioner) readTransaction(
	agentID string,
	selection profileSelection,
) (managedProfileTransaction, bool, error) {
	var transaction managedProfileTransaction
	err := p.transactionStore().Read(
		p.transactionRelativePath(selection.Name),
		&transaction,
	)
	if errors.Is(err, os.ErrNotExist) {
		return managedProfileTransaction{}, false, nil
	}
	if err != nil {
		return managedProfileTransaction{}, false, err
	}
	if err := p.validateTransaction(transaction); err != nil {
		return managedProfileTransaction{}, false, err
	}
	if transaction.AgentID != agentID ||
		transaction.ProfileName != selection.Name ||
		filepath.Clean(transaction.ProfileHome) != selection.Home {
		return managedProfileTransaction{}, false, errors.New(
			"Hermes Profile transaction does not match the Agent",
		)
	}
	return transaction, true, nil
}

func (p *nativeProfileProvisioner) validateTransaction(
	transaction managedProfileTransaction,
) error {
	if transaction.Schema != profileTransactionSchema {
		return errors.New("Hermes Profile transaction schema is unsupported")
	}
	decodedTransactionID, decodeErr := hex.DecodeString(
		transaction.TransactionID,
	)
	if len(transaction.TransactionID) != 32 ||
		transaction.TransactionID != strings.ToLower(transaction.TransactionID) ||
		decodeErr != nil ||
		len(decodedTransactionID) != 16 ||
		strings.TrimSpace(transaction.AgentID) == "" {
		return errors.New("Hermes Profile transaction identity is invalid")
	}
	if transaction.CreatedAt.IsZero() {
		return errors.New("Hermes Profile transaction creation time is invalid")
	}
	selection, err := managedProfileSelection(
		p.trustedHome,
		transaction.AgentID,
	)
	if err != nil {
		return err
	}
	if transaction.ProfileName != selection.Name ||
		filepath.Clean(transaction.ProfileHome) != selection.Home ||
		filepath.Clean(transaction.TemplateHome) !=
			filepath.Join(p.trustedHome, ".hermes") {
		return errors.New("Hermes Profile transaction path is invalid")
	}
	switch transaction.Phase {
	case profileTransactionPlanned,
		profileTransactionNativeCreated,
		profileTransactionScrubbed,
		profileTransactionCommitted:
		return nil
	default:
		return errors.New("Hermes Profile transaction phase is invalid")
	}
}

func (p *nativeProfileProvisioner) removeTransaction(
	profileName string,
) error {
	return p.transactionStore().Remove(
		p.transactionRelativePath(profileName),
	)
}
