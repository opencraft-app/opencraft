package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	ManagementPolicyObserve         ManagementPolicy = "Observe"
	ManagementPolicyAdoptionPending ManagementPolicy = "AdoptionPending"
	ManagementPolicyManaged         ManagementPolicy = "Managed"
)

type ManagementPolicy string

type AdminRuntimeSpec struct {
	Image string `json:"image"`
}

type TrafficRuntimeSpec struct {
	Generation int64  `json:"generation"`
	Image      string `json:"image"`
	Replicas   int32  `json:"replicas"`
}

type SchedulingSpec struct {
	PriorityClassName string `json:"priorityClassName,omitempty"`
	ImagePullSecret   string `json:"imagePullSecret,omitempty"`
	ServerlessTraffic bool   `json:"serverlessTraffic,omitempty"`
}

type TrafficAvailabilitySpec struct {
	TopologyKey     string `json:"topologyKey,omitempty"`
	PDBMinAvailable int32  `json:"pdbMinAvailable,omitempty"`
}

type DecommissionApproval struct {
	RequestID    string      `json:"requestID"`
	Attempt      int32       `json:"attempt"`
	ApprovedAt   metav1.Time `json:"approvedAt"`
	CRUID        string      `json:"crUID"`
	FleetRef     string      `json:"fleetRef"`
	ShardRef     string      `json:"shardRef"`
	DatabaseName string      `json:"databaseName"`
	RedisDB      int32       `json:"redisDB"`
}

type VelaGWSetSpec struct {
	FleetRef             string                      `json:"fleetRef"`
	ShardRef             string                      `json:"shardRef"`
	DatabaseName         string                      `json:"databaseName"`
	RedisDB              int32                       `json:"redisDB"`
	RuntimeSecretRef     corev1.LocalObjectReference `json:"runtimeSecretRef"`
	ManagementPolicy     ManagementPolicy            `json:"managementPolicy,omitempty"`
	Scheduling           SchedulingSpec              `json:"scheduling,omitempty"`
	TrafficAvailability  TrafficAvailabilitySpec     `json:"trafficAvailability,omitempty"`
	DecommissionApproval *DecommissionApproval       `json:"decommissionApproval,omitempty"`
	Admin                AdminRuntimeSpec            `json:"admin"`
	TrafficRuntimes      []TrafficRuntimeSpec        `json:"trafficRuntimes"`
}

type TrafficRuntimeStatus struct {
	Generation        int64 `json:"generation"`
	DesiredReplicas   int32 `json:"desiredReplicas,omitempty"`
	ReadyReplicas     int32 `json:"readyReplicas,omitempty"`
	AvailableReplicas int32 `json:"availableReplicas,omitempty"`
}

type VelaGWSetStatus struct {
	ObservedGeneration int64                  `json:"observedGeneration,omitempty"`
	AdminReadyReplicas int32                  `json:"adminReadyReplicas,omitempty"`
	TrafficRuntimes    []TrafficRuntimeStatus `json:"trafficRuntimes,omitempty"`
	Conditions         []metav1.Condition     `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=vgs
type VelaGWSet struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              VelaGWSetSpec   `json:"spec,omitempty"`
	Status            VelaGWSetStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type VelaGWSetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []VelaGWSet `json:"items"`
}

var GroupVersion = schema.GroupVersion{Group: "gateway.lightvela.com", Version: "v1alpha1"}

var SchemeBuilder = runtime.NewSchemeBuilder(func(scheme *runtime.Scheme) error {
	scheme.AddKnownTypes(GroupVersion, &VelaGWSet{}, &VelaGWSetList{})
	metav1.AddToGroupVersion(scheme, GroupVersion)
	return nil
})

var AddToScheme = SchemeBuilder.AddToScheme

func (in *VelaGWSet) DeepCopyInto(out *VelaGWSet) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	if in.Spec.TrafficRuntimes != nil {
		out.Spec.TrafficRuntimes = make([]TrafficRuntimeSpec, len(in.Spec.TrafficRuntimes))
		copy(out.Spec.TrafficRuntimes, in.Spec.TrafficRuntimes)
	}
	if in.Spec.DecommissionApproval != nil {
		out.Spec.DecommissionApproval = new(DecommissionApproval)
		*out.Spec.DecommissionApproval = *in.Spec.DecommissionApproval
	}
	if in.Status.TrafficRuntimes != nil {
		out.Status.TrafficRuntimes = make([]TrafficRuntimeStatus, len(in.Status.TrafficRuntimes))
		copy(out.Status.TrafficRuntimes, in.Status.TrafficRuntimes)
	}
	if in.Status.Conditions != nil {
		out.Status.Conditions = make([]metav1.Condition, len(in.Status.Conditions))
		copy(out.Status.Conditions, in.Status.Conditions)
	}
}

func (in *VelaGWSet) DeepCopy() *VelaGWSet {
	if in == nil {
		return nil
	}
	out := new(VelaGWSet)
	in.DeepCopyInto(out)
	return out
}

func (in *VelaGWSet) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}

func (in *VelaGWSetList) DeepCopyInto(out *VelaGWSetList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]VelaGWSet, len(in.Items))
		for index := range in.Items {
			in.Items[index].DeepCopyInto(&out.Items[index])
		}
	}
}

func (in *VelaGWSetList) DeepCopy() *VelaGWSetList {
	if in == nil {
		return nil
	}
	out := new(VelaGWSetList)
	in.DeepCopyInto(out)
	return out
}

func (in *VelaGWSetList) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}
