package main

import "testing"

func TestResolveShardServiceTemplateUsesPodNamespaceByDefault(t *testing.T) {
	t.Setenv("POD_NAMESPACE", "lightvela-playground-sandbox-bj-7")
	t.Setenv("INGRESSPROXY_SHARD_SERVICE_TEMPLATE", "")

	got := resolveShardServiceTemplate()
	want := "http://ingressproxy-g%d.lightvela-playground-sandbox-bj-7.svc.cluster.local"
	if got != want {
		t.Fatalf("resolveShardServiceTemplate()=%q want %q", got, want)
	}
}

func TestResolveShardServiceTemplateExpandsNamespacePlaceholder(t *testing.T) {
	t.Setenv("POD_NAMESPACE", "sandbox-bj-7")
	t.Setenv("INGRESSPROXY_SHARD_SERVICE_TEMPLATE", "http://ingressproxy-g%d.$(POD_NAMESPACE).svc.cluster.local")

	got := resolveShardServiceTemplate()
	want := "http://ingressproxy-g%d.sandbox-bj-7.svc.cluster.local"
	if got != want {
		t.Fatalf("resolveShardServiceTemplate()=%q want %q", got, want)
	}
}

func TestResolveShardServiceTemplateFallsBackToSandboxNamespace(t *testing.T) {
	t.Setenv("POD_NAMESPACE", "")
	t.Setenv("INGRESSPROXY_SHARD_SERVICE_TEMPLATE", "")

	got := resolveShardServiceTemplate()
	want := "http://ingressproxy-g%d.sandbox.svc.cluster.local"
	if got != want {
		t.Fatalf("resolveShardServiceTemplate()=%q want %q", got, want)
	}
}
