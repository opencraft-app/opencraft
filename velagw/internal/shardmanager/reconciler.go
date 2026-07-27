package shardmanager

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"git.woa.com/wisp/mono2/llmgateway/internal/setmanager"
)

var llmFleetGVK = schema.GroupVersionKind{
	Group: "llmgateway.io", Version: "v1alpha1", Kind: "LLMFleet",
}

type Reconciler struct {
	client.Client
	Control Control
	Fleet   string
}

func (r *Reconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	if r.Fleet != "" && request.Name != r.Fleet {
		return ctrl.Result{}, nil
	}
	object := fleetObject()
	if err := r.Get(ctx, request.NamespacedName, object); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	var fleet setmanager.LLMFleet
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(object.Object, &fleet); err != nil {
		return ctrl.Result{}, fmt.Errorf("decode fleet %s/%s: %w", request.Namespace, request.Name, err)
	}
	if err := ProjectFleetShards(ctx, r.Control, fleet); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 10 * time.Minute}, nil
}

func (r *Reconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).
		For(fleetObject()).
		Complete(r)
}

func fleetObject() *unstructured.Unstructured {
	object := &unstructured.Unstructured{}
	object.SetGroupVersionKind(llmFleetGVK)
	return object
}
