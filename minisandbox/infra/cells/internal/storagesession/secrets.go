package storagesession

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

// ActorCell is the fleet concept; the installed CRD is RivetCell, not ActorCell.
var cellGVR = schema.GroupVersionResource{Group: "fleet.actor.dev", Version: "v1alpha1", Resource: "rivetcells"}

const cellAPIVersion = "fleet.actor.dev/v1alpha1"
const annotationPrefix = "fleet.actor.dev/"

func (c *controller) checkScope(ctx context.Context) error {
	call, cancel := context.WithTimeout(ctx, c.config.timeout())
	defer cancel()
	ns, err := c.core.Namespaces().Get(call, c.config.Namespace, metav1.GetOptions{})
	if err != nil {
		return errors.New("namespace_read_failed")
	}
	if ns.UID != types.UID(c.config.NamespaceUID) || ns.DeletionTimestamp != nil {
		return errors.New("namespace_identity_drift")
	}
	cell, err := c.dynamic.Resource(cellGVR).Namespace(c.config.Namespace).Get(call, c.config.CellName, metav1.GetOptions{})
	if err != nil {
		return errors.New("cell_read_failed")
	}
	if cell.GetUID() != types.UID(c.config.CellUID) || cell.GetNamespace() != c.config.Namespace || cell.GetAPIVersion() != cellAPIVersion || cell.GetKind() != "RivetCell" || cell.GetDeletionTimestamp() != nil {
		return errors.New("cell_identity_drift")
	}
	return nil
}

func (c *controller) owned(m metav1.Object) bool {
	if m.GetNamespace() != c.config.Namespace || m.GetDeletionTimestamp() != nil || m.GetResourceVersion() == "" {
		return false
	}
	refs := m.GetOwnerReferences()
	return len(refs) == 1 && refs[0].UID == types.UID(c.config.CellUID) && refs[0].Name == c.config.CellName && refs[0].Kind == "RivetCell" && refs[0].APIVersion == cellAPIVersion
}

func (c *controller) bindings(r Role) map[string]string {
	return map[string]string{
		annotationPrefix + "session-role":        r.Name,
		annotationPrefix + "session-role-arn":    r.ARN,
		annotationPrefix + "session-provider-id": c.config.ProviderID,
		annotationPrefix + "session-audience":    c.config.Audience,
		annotationPrefix + "session-backup-host": r.BackupHost,
	}
}

func (c *controller) validateSecret(s *corev1.Secret, r Role) error {
	bad := errors.New("secret_identity_drift")
	if s.Name != r.SecretName || s.UID != types.UID(r.SecretUID) || !c.owned(s) || s.Type != corev1.SecretTypeOpaque || (s.Immutable != nil && *s.Immutable) ||
		s.Labels["fleet.actor.dev/cell-name"] != c.config.CellName || s.Labels["app.kubernetes.io/managed-by"] != c.config.ManagedBy {
		return bad
	}
	// Existing UID-pinned qualification Secrets predate these public annotations.
	// Adopt only when ALL bindings are absent; never accept partial or changed bindings.
	present := 0
	for k, v := range c.bindings(r) {
		if old, ok := s.Annotations[k]; ok {
			present++
			if old != v {
				return bad
			}
		}
	}
	if present != 0 && present != len(c.bindings(r)) {
		return bad
	}
	return nil
}

func readSession(s *corev1.Secret, r Role) (session, error) {
	bad := errors.New("secret_session_invalid")
	expiry, err := strconv.ParseInt(s.Annotations[annotationPrefix+"session-expiry"], 10, 64)
	if err != nil || expiry <= 0 {
		return session{}, bad
	}
	var tuple session
	if r.Name != "backup" {
		if len(s.Data) != 1 || len(s.Data["session.json"]) > 16384 || json.Unmarshal(s.Data["session.json"], &tuple) != nil {
			return session{}, bad
		}
	} else {
		if len(s.Data) < 1 || len(s.Data) > 2 || len(s.Data["credentials"]) > 16384 {
			return session{}, bad
		}
		var backup struct {
			Accounts map[string]map[string]string `json:"accounts"`
		}
		if json.Unmarshal(s.Data["credentials"], &backup) != nil || len(backup.Accounts) != 1 {
			return session{}, bad
		}
		account := backup.Accounts["@"+r.BackupHost]
		if len(account) != 3 {
			return session{}, bad
		}
		tuple = session{account["api_key"], account["secret"], account["token"], expiry}
		// Legacy backup Secrets have only credentials + the expiry annotation.
		// New writes publish session.json and credentials in the SAME Secret Update.
		if len(s.Data) == 2 {
			var recorded session
			if len(s.Data["session.json"]) > 16384 || json.Unmarshal(s.Data["session.json"], &recorded) != nil || recorded != tuple {
				return session{}, bad
			}
		}
	}
	if !tuple.valid() || tuple.ExpiresAt != expiry {
		return session{}, bad
	}
	return tuple, nil
}

func (c *controller) getSecret(ctx context.Context, r Role) (*corev1.Secret, error) {
	call, cancel := context.WithTimeout(ctx, c.config.timeout())
	defer cancel()
	s, err := c.core.Secrets(c.config.Namespace).Get(call, r.SecretName, metav1.GetOptions{})
	if err != nil {
		return nil, errors.New("secret_read_failed")
	}
	return s, c.validateSecret(s, r)
}

func (c *controller) publish(ctx context.Context, r Role, observed *corev1.Secret, tuple session) error {
	if !tuple.valid() || tuple.ExpiresAt <= time.Now().Unix()+c.config.RenewBeforeSeconds {
		return errors.New("new_session_expiring")
	}
	if err := c.checkScope(ctx); err != nil {
		return err
	}
	live, err := c.getSecret(ctx, r)
	if err != nil {
		return err
	}
	if live.ResourceVersion != observed.ResourceVersion {
		return errors.New("secret_cas_conflict")
	}
	desired := live.DeepCopy()
	encoded, err := json.Marshal(tuple)
	if err != nil {
		return errors.New("session_encode_failed")
	}
	desired.Data = map[string][]byte{"session.json": encoded}
	if r.Name == "backup" {
		backup := map[string]any{"accounts": map[string]any{"@" + r.BackupHost: map[string]string{"api_key": tuple.AccessKeyID, "secret": tuple.SecretAccessKey, "token": tuple.SessionToken}}}
		encoded, err = json.Marshal(backup)
		if err != nil {
			return errors.New("session_encode_failed")
		}
		desired.Data["credentials"] = encoded
	}
	if desired.Annotations == nil {
		desired.Annotations = map[string]string{}
	}
	for k, v := range c.bindings(r) {
		desired.Annotations[k] = v
	}
	desired.Annotations[annotationPrefix+"session-expiry"] = strconv.FormatInt(tuple.ExpiresAt, 10)
	generation, err := randomID()
	if err != nil {
		return err
	}
	desired.Annotations[annotationPrefix+"session-generation"] = generation
	// Check live lease immediately before this one CAS. No Update retry on conflict,
	// timeout or ambiguous result; the next cycle reads the exact Secret first.
	if err = c.holdsLease(ctx); err != nil {
		return err
	}
	call, cancel := context.WithTimeout(ctx, c.config.timeout())
	defer cancel()
	if call.Err() != nil {
		return errors.New("leadership_cancelled")
	}
	_, err = c.core.Secrets(c.config.Namespace).Update(call, desired, metav1.UpdateOptions{})
	if err != nil {
		return errors.New("secret_update_unconfirmed")
	}
	return nil
}
