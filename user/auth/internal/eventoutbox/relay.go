package eventoutbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/apache/pulsar-client-go/pulsar"
	"github.com/google/uuid"
)

type Config struct {
	URL          string
	Token        string
	Topic        string
	PollInterval time.Duration
	Lease        time.Duration
}

type Relay struct {
	db       *sql.DB
	client   pulsar.Client
	producer pulsar.Producer
	cfg      Config
	mu       sync.Mutex
	cancel   context.CancelFunc
	runWG    sync.WaitGroup
}

type claimedEvent struct {
	ID       string
	Type     string
	Payload  []byte
	Attempts int
	Lease    string
}

func New(db *sql.DB, cfg Config) (*Relay, error) {
	if db == nil {
		return nil, fmt.Errorf("outbox database is required")
	}
	if strings.TrimSpace(cfg.URL) == "" || strings.TrimSpace(cfg.Token) == "" || strings.TrimSpace(cfg.Topic) == "" {
		return nil, fmt.Errorf("outbox Pulsar configuration is incomplete")
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = time.Second
	}
	if cfg.Lease <= 0 {
		cfg.Lease = 30 * time.Second
	}
	return &Relay{db: db, cfg: cfg}, nil
}

func (r *Relay) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	cancel := r.cancel
	r.cancel = nil
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	r.runWG.Wait()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closeProducerLocked()
}

func (r *Relay) Start(parent context.Context) {
	r.mu.Lock()
	if r.cancel != nil {
		r.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	r.runWG.Add(1)
	r.mu.Unlock()
	go func() {
		defer r.runWG.Done()
		r.Run(ctx)
	}()
}

func (r *Relay) closeProducerLocked() {
	if r.producer != nil {
		r.producer.Close()
		r.producer = nil
	}
	if r.client != nil {
		r.client.Close()
		r.client = nil
	}
}

func (r *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(r.cfg.PollInterval)
	defer ticker.Stop()
	for {
		for published := 0; published < 100; published++ {
			didPublish, err := r.publishOne(ctx)
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					slog.ErrorContext(ctx, "auth referral outbox publish failed", "err", err)
				}
				break
			}
			if !didPublish {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Relay) publishOne(ctx context.Context) (bool, error) {
	if err := r.ensureProducer(); err != nil {
		return false, err
	}
	event, err := r.claim(ctx, time.Now().UTC())
	if err != nil {
		return false, err
	}
	if event == nil {
		return false, nil
	}
	err = r.send(ctx, &pulsar.ProducerMessage{
		Payload: event.Payload,
		Key:     event.ID,
		Properties: map[string]string{
			"event_id": event.ID, "event_type": event.Type, "producer": "user-auth",
		},
	})
	if err != nil {
		r.resetProducer()
		return false, r.fail(ctx, event, err)
	}
	_, err = r.db.ExecContext(ctx, `
		UPDATE auth_event_outbox
		SET status = 'published', published_at = ?, lease_token = NULL,
		    lease_expires_at = NULL, last_error = NULL
		WHERE event_id = ? AND status = 'publishing' AND lease_token = ?
	`, time.Now().UTC(), event.ID, event.Lease)
	return err == nil, err
}

func (r *Relay) ensureProducer() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ensureProducerLocked()
}

func (r *Relay) ensureProducerLocked() error {
	if r.producer != nil {
		return nil
	}
	client, err := pulsar.NewClient(pulsar.ClientOptions{
		URL: r.cfg.URL, Authentication: pulsar.NewAuthenticationToken(r.cfg.Token),
	})
	if err != nil {
		return err
	}
	producer, err := client.CreateProducer(pulsar.ProducerOptions{Topic: r.cfg.Topic, DisableBatching: true})
	if err != nil {
		client.Close()
		return err
	}
	r.client = client
	r.producer = producer
	return nil
}

func (r *Relay) send(ctx context.Context, message *pulsar.ProducerMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ensureProducerLocked(); err != nil {
		return err
	}
	_, err := r.producer.Send(ctx, message)
	return err
}

func (r *Relay) resetProducer() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closeProducerLocked()
}

func (r *Relay) claim(ctx context.Context, now time.Time) (*claimedEvent, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE auth_event_outbox
		SET status = 'pending', lease_token = NULL, lease_expires_at = NULL
		WHERE status = 'publishing' AND lease_expires_at <= ?
	`, now); err != nil {
		return nil, err
	}
	var event claimedEvent
	err = tx.QueryRowContext(ctx, `
		SELECT event_id, event_type, payload_json, attempt_count
		FROM auth_event_outbox
		WHERE status = 'pending' AND next_attempt_at <= ?
		  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
		ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
	`, now, now).Scan(&event.ID, &event.Type, &event.Payload, &event.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	event.Lease = uuid.NewString()
	if _, err := tx.ExecContext(ctx, `
		UPDATE auth_event_outbox
		SET status = 'publishing', lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1
		WHERE event_id = ? AND status = 'pending'
	`, event.Lease, now.Add(r.cfg.Lease), event.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	event.Attempts++
	return &event, nil
}

func (r *Relay) fail(ctx context.Context, event *claimedEvent, publishErr error) error {
	delay := time.Duration(math.Min(math.Pow(2, float64(event.Attempts)), 300)) * time.Second
	_, err := r.db.ExecContext(ctx, `
		UPDATE auth_event_outbox
		SET status = 'pending', next_attempt_at = ?, lease_token = NULL,
		    lease_expires_at = NULL, last_error = ?
		WHERE event_id = ? AND status = 'publishing' AND lease_token = ?
	`, time.Now().UTC().Add(delay), truncate(publishErr.Error(), 1024), event.ID, event.Lease)
	if err != nil {
		return errors.Join(publishErr, err)
	}
	return publishErr
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
