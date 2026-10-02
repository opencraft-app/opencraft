import {
	faBarcodeRead,
	faDatabase,
	faPencil,
	faRunning,
	faSignalStream,
	type IconProp,
} from "@rivet-gg/icons";
import type { MetricType } from "@/app/billing/usage-format";

export interface UsageMetricConfig {
	key: string;
	title: string;
	description: string;
	icon: IconProp;
	metricType: MetricType;
}

// Display metadata (title, description, icon) for each billed metric, in render
// order. The usage endpoint owns the numbers and which metrics exist.
export const USAGE_METRICS: UsageMetricConfig[] = [
	{
		key: "actor_awake",
		title: "Awake actors",
		description: "Time your actors spend running and processing requests.",
		icon: faRunning,
		metricType: "hours",
	},
	{
		key: "kv_storage_used",
		title: "State storage",
		description:
			"Persistent data stored in actor state across all namespaces.",
		icon: faDatabase,
		metricType: "bytes",
	},
	{
		key: "kv_read",
		title: "Reads",
		description: "Data read from actor state, measured in 4KiB units.",
		icon: faBarcodeRead,
		metricType: "operations",
	},
	{
		key: "kv_write",
		title: "Writes",
		description: "Data written to actor state, measured in 4KiB units.",
		icon: faPencil,
		metricType: "operations",
	},
	{
		key: "gateway_egress",
		title: "Egress",
		description:
			"Network traffic sent from your actors to external clients.",
		icon: faSignalStream,
		metricType: "bytes",
	},
];
