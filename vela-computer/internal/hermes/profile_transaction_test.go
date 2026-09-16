package hermes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagedProfileTransactionRejectsMalformedIdentity(t *testing.T) {
	t.Parallel()

	provisioner, selection := newTransactionTestProvisioner(t, "agent-1")
	transaction, err := provisioner.newTransaction("agent-1", selection)
	if err != nil {
		t.Fatal(err)
	}

	t.Run("transaction id", func(t *testing.T) {
		malformed := transaction
		malformed.TransactionID = "not-random-hex"
		if err := provisioner.validateTransaction(
			malformed,
		); err == nil || !strings.Contains(err.Error(), "identity") {
			t.Fatalf("transaction identity error = %v", err)
		}
	})

	t.Run("creation time", func(t *testing.T) {
		malformed := transaction
		malformed.CreatedAt = time.Time{}
		if err := provisioner.validateTransaction(
			malformed,
		); err == nil || !strings.Contains(err.Error(), "creation") {
			t.Fatalf("transaction creation error = %v", err)
		}
	})
}

func TestManagedProfileTransactionFailsClosed(t *testing.T) {
	t.Parallel()

	provisioner, selection := newTransactionTestProvisioner(t, "agent-1")
	base, err := provisioner.newTransaction("agent-1", selection)
	if err != nil {
		t.Fatal(err)
	}

	cases := map[string]func(*managedProfileTransaction){
		"future schema": func(transaction *managedProfileTransaction) {
			transaction.Schema++
		},
		"unknown phase": func(transaction *managedProfileTransaction) {
			transaction.Phase = "future"
		},
		"mismatched Agent": func(transaction *managedProfileTransaction) {
			transaction.AgentID = "agent-2"
		},
		"escaping Profile path": func(transaction *managedProfileTransaction) {
			transaction.ProfileHome = filepath.Join(
				provisioner.trustedHome,
				".hermes",
				"profiles",
				"..",
				"..",
				"outside",
			)
		},
		"mismatched template path": func(transaction *managedProfileTransaction) {
			transaction.TemplateHome = filepath.Join(
				provisioner.trustedHome,
				"elsewhere",
			)
		},
	}
	for name, mutate := range cases {
		name := name
		mutate := mutate
		t.Run(name, func(t *testing.T) {
			transaction := base
			mutate(&transaction)
			if err := provisioner.transactionStore().Write(
				provisioner.transactionRelativePath(selection.Name),
				transaction,
			); err != nil {
				t.Fatal(err)
			}
			if _, _, err := provisioner.readTransaction(
				"agent-1",
				selection,
			); err == nil {
				t.Fatal("invalid transaction was accepted")
			}
		})
	}
}

func TestManagedProfileTransactionStorageIsRestricted(t *testing.T) {
	t.Parallel()

	provisioner, selection := newTransactionTestProvisioner(t, "agent-1")
	transaction, err := provisioner.newTransaction("agent-1", selection)
	if err != nil {
		t.Fatal(err)
	}
	if err := provisioner.writeTransaction(transaction); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(provisioner.transactionPath(selection.Name))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("transaction mode = %o", info.Mode().Perm())
	}
	controlInfo, err := os.Stat(filepath.Dir(filepath.Dir(
		provisioner.transactionPath(selection.Name),
	)))
	if err != nil {
		t.Fatal(err)
	}
	if controlInfo.Mode().Perm() != 0o700 {
		t.Fatalf("transaction control mode = %o", controlInfo.Mode().Perm())
	}
}

func TestManagedProfileTransactionRejectsMalformedJSON(t *testing.T) {
	t.Parallel()

	provisioner, selection := newTransactionTestProvisioner(t, "agent-1")
	if err := provisioner.transactionStore().WriteFile(
		provisioner.transactionRelativePath(selection.Name),
		[]byte("{"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := provisioner.readTransaction(
		"agent-1",
		selection,
	); err == nil {
		t.Fatal("malformed transaction JSON was accepted")
	}
}

func newTransactionTestProvisioner(
	t *testing.T,
	agentID string,
) (*nativeProfileProvisioner, profileSelection) {
	t.Helper()
	trustedHome := t.TempDir()
	if err := os.MkdirAll(
		filepath.Join(trustedHome, ".hermes"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	provisioner, err := newNativeProfileProvisioner(profileProvisionerOptions{
		TrustedHome: trustedHome,
		Candidate:   executableCandidate{Path: "/opt/hermes/bin/hermes"},
		Run: func(
			context.Context,
			profileCommandRequest,
		) ([]byte, error) {
			return nil, errors.New("not used")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	selection, err := managedProfileSelection(trustedHome, agentID)
	if err != nil {
		t.Fatal(err)
	}
	return provisioner, selection
}
