package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type kubeClient struct {
	baseURL string
	token   string
	client  *http.Client
}

type kubeHTTPError struct {
	Status int
	Body   string
}

func (e kubeHTTPError) Error() string {
	return fmt.Sprintf("kubernetes returned %d: %s", e.Status, e.Body)
}

type cronJob struct {
	Spec struct {
		Suspend     *bool `json:"suspend,omitempty"`
		JobTemplate struct {
			Spec map[string]any `json:"spec"`
		} `json:"jobTemplate"`
	} `json:"spec"`
}

type kubeJob struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Status struct {
		Succeeded int `json:"succeeded"`
		Failed    int `json:"failed"`
		Active    int `json:"active"`
	} `json:"status"`
}

type kubeDeployment struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Replicas int `json:"replicas"`
		Template struct {
			Spec struct {
				Containers []struct {
					Name  string `json:"name"`
					Image string `json:"image"`
				} `json:"containers"`
			} `json:"spec"`
		} `json:"template"`
	} `json:"spec"`
	Status struct {
		ReadyReplicas     int64 `json:"readyReplicas"`
		UpdatedReplicas   int64 `json:"updatedReplicas"`
		AvailableReplicas int64 `json:"availableReplicas"`
	} `json:"status"`
}

func newInClusterKubeClient() (kubeClient, error) {
	host := envString("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
	port := envString("KUBERNETES_SERVICE_PORT", "443")
	token, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
	if err != nil {
		return kubeClient{}, err
	}
	ca, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err != nil {
		return kubeClient{}, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return kubeClient{}, fmt.Errorf("load service account CA")
	}
	return kubeClient{
		baseURL: "https://" + host + ":" + port,
		token:   strings.TrimSpace(string(token)),
		client: &http.Client{Timeout: 45 * time.Second, Transport: &http.Transport{
			TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		}},
	}, nil
}

func (c kubeClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		contentType := "application/json"
		if method == http.MethodPatch {
			contentType = "application/merge-patch+json"
		}
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return kubeHTTPError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func (c kubeClient) cronJob(ctx context.Context, namespace, name string) (cronJob, error) {
	var result cronJob
	err := c.do(ctx, http.MethodGet, batchPath(namespace, "cronjobs/"+name), nil, &result)
	return result, err
}

func (c kubeClient) setCronJobSuspended(ctx context.Context, namespace, name string, suspended bool) error {
	return c.do(ctx, http.MethodPatch, batchPath(namespace, "cronjobs/"+name), map[string]any{
		"spec": map[string]any{"suspend": suspended},
	}, nil)
}

func (c kubeClient) createManagerJob(ctx context.Context, namespace, cronName, jobName, probeModel string) error {
	cron, err := c.cronJob(ctx, namespace, cronName)
	if err != nil {
		return err
	}
	spec := deepCopyMap(cron.Spec.JobTemplate.Spec)
	if err := upsertManagerProbeModel(spec, probeModel); err != nil {
		return err
	}
	body := map[string]any{
		"apiVersion": "batch/v1", "kind": "Job",
		"metadata": map[string]any{
			"name": jobName,
			"labels": map[string]string{
				"app.kubernetes.io/name": "llmgateway-set-upgrade-soak-manager",
				"llmgateway.io/owned-by": "set-upgrade-soak",
			},
		},
		"spec": spec,
	}
	return c.do(ctx, http.MethodPost, batchPath(namespace, "jobs"), body, nil)
}

func (c kubeClient) waitJob(ctx context.Context, namespace, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var job kubeJob
		if err := c.do(ctx, http.MethodGet, batchPath(namespace, "jobs/"+name), nil, &job); err != nil {
			return err
		}
		if job.Status.Succeeded > 0 {
			return nil
		}
		if job.Status.Failed > 0 {
			return fmt.Errorf("manager job %s failed", name)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("manager job %s did not finish before %s", name, timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func (c kubeClient) deleteJob(ctx context.Context, namespace, name string) error {
	err := c.do(ctx, http.MethodDelete, batchPath(namespace, "jobs/"+name), map[string]any{
		"propagationPolicy": "Background",
	}, nil)
	var kubeErr kubeHTTPError
	if errors.As(err, &kubeErr) && kubeErr.Status == http.StatusNotFound {
		return nil
	}
	return err
}

func (c kubeClient) deployment(ctx context.Context, namespace, name string) (kubeDeployment, bool, error) {
	var result kubeDeployment
	err := c.do(ctx, http.MethodGet, appsPath(namespace, "deployments/"+name), nil, &result)
	var kubeErr kubeHTTPError
	if errors.As(err, &kubeErr) && kubeErr.Status == http.StatusNotFound {
		return result, false, nil
	}
	return result, err == nil, err
}

func (c kubeClient) waitDeploymentReady(ctx context.Context, namespace, name, image string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		deployment, exists, err := c.deployment(ctx, namespace, name)
		if err != nil {
			return err
		}
		if exists && deployment.Status.ReadyReplicas >= int64(deployment.Spec.Replicas) && deployment.Spec.Replicas > 0 {
			foundImage := false
			for _, container := range deployment.Spec.Template.Spec.Containers {
				if container.Image == image {
					foundImage = true
					break
				}
			}
			if !foundImage {
				return fmt.Errorf("deployment %s is ready but does not use %s", name, image)
			}
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("deployment %s did not become ready", name)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

func deepCopyMap(value map[string]any) map[string]any {
	raw, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(raw, &result)
	return result
}

func batchPath(namespace, suffix string) string {
	return "/apis/batch/v1/namespaces/" + namespace + "/" + suffix
}

func appsPath(namespace, suffix string) string {
	return "/apis/apps/v1/namespaces/" + namespace + "/" + suffix
}
