package store

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestNodeIdentityAndDatabasePermissionsPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hypernode.sqlite")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.GetOrInsertNodeIdentity("ssh-ed25519", []byte("first-private-key"))
	if err != nil || !bytes.Equal(first, []byte("first-private-key")) {
		t.Fatalf("first=%q err=%v", first, err)
	}
	second, err := st.GetOrInsertNodeIdentity("ssh-ed25519", []byte("replacement"))
	if err != nil || !bytes.Equal(second, first) {
		t.Fatalf("second=%q err=%v", second, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database mode=%o, want 600", info.Mode().Perm())
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	stored, found, err := st.NodeIdentity("ssh-ed25519")
	if err != nil || !found || !bytes.Equal(stored, first) {
		t.Fatalf("stored=%q found=%v err=%v", stored, found, err)
	}
}

func TestSanitizeSecretsRecursively(t *testing.T) {
	value := sanitize(map[string]any{
		"username":       "codex",
		"password":       "cleartext",
		"nested":         map[string]any{"authorization": "Bearer value"},
		"passwordSha256": "fingerprint",
	}).(map[string]any)
	if value["password"] != "[REDACTED]" {
		t.Fatalf("password was not redacted: %#v", value)
	}
	if value["passwordSha256"] != "fingerprint" {
		t.Fatalf("password fingerprint should remain visible: %#v", value)
	}
	nested := value["nested"].(map[string]any)
	if nested["authorization"] != "[REDACTED]" {
		t.Fatalf("nested authorization was not redacted: %#v", nested)
	}
}

func TestProtocolRecordIsDisabled(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "hypernode.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.OpenConnection("connection-1", "127.0.0.1:9988", "test"); err != nil {
		t.Fatal(err)
	}
	if err := st.Record("connection-1", "session-1", "stream.input", map[string]any{
		"payload": "must not be persisted",
	}); err != nil {
		t.Fatal(err)
	}
	events, err := st.Events("connection-1", 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("protocol audit unexpectedly persisted %d events", len(events))
	}
}

func TestPolicyKVPersistsAndGetOrInsertIsStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hypernode.sqlite")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.GetOrInsert("deviceIdentity", "installationId", "first")
	if err != nil || first != "first" {
		t.Fatalf("first=%q err=%v", first, err)
	}
	second, err := st.GetOrInsert("deviceIdentity", "installationId", "second")
	if err != nil || second != "first" {
		t.Fatalf("second=%q err=%v", second, err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	st, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	value, found, err := st.Get("deviceIdentity", "installationId")
	if err != nil || !found || value != "first" {
		t.Fatalf("value=%q found=%v err=%v", value, found, err)
	}
	if err := st.Set("deviceIdentity", "installationId", "updated"); err != nil {
		t.Fatal(err)
	}
	deleted, err := st.Delete("deviceIdentity", "installationId")
	if err != nil || !deleted {
		t.Fatalf("deleted=%v err=%v", deleted, err)
	}
	_, found, err = st.Get("deviceIdentity", "installationId")
	if err != nil || found {
		t.Fatalf("found after delete=%v err=%v", found, err)
	}

	const workers = 16
	results := make(chan string, workers)
	errors := make(chan error, workers)
	var group sync.WaitGroup
	for index := 0; index < workers; index++ {
		group.Add(1)
		go func(candidate string) {
			defer group.Done()
			value, err := st.GetOrInsert("concurrent", "identity", candidate)
			results <- value
			errors <- err
		}(string(rune('a' + index)))
	}
	group.Wait()
	close(results)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	winner := ""
	for value := range results {
		if winner == "" {
			winner = value
		}
		if value != winner {
			t.Fatalf("getOrInsert returned multiple winners: %q and %q", winner, value)
		}
	}
}

func TestPolicySQLAndSynchronousTransactions(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "hypernode.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, _, _, err := st.ExecPolicySQL(`CREATE TABLE do_messages(id INTEGER PRIMARY KEY, body TEXT NOT NULL)`, nil); err != nil {
		t.Fatal(err)
	}
	columns, rows, written, err := st.ExecPolicySQL(
		`INSERT INTO do_messages(body) VALUES (?), (?) RETURNING id, body`,
		[]any{"alpha", "beta"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 2 || len(rows) != 2 || written != 2 || rows[1][1] != "beta" {
		t.Fatalf("columns=%v rows=%v written=%d", columns, rows, written)
	}
	err = st.TransactionPolicySQL(func(exec func(string, []any) ([]string, [][]any, int64, error)) error {
		if _, _, _, err := exec(`INSERT INTO do_messages(body) VALUES (?)`, []any{"rollback"}); err != nil {
			return err
		}
		return fmt.Errorf("synthetic rollback")
	})
	if err == nil {
		t.Fatal("transaction unexpectedly committed")
	}
	_, rows, _, err = st.ExecPolicySQL(`SELECT count(*) AS count FROM do_messages`, nil)
	if err != nil || len(rows) != 1 || rows[0][0] != int64(2) {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
}
