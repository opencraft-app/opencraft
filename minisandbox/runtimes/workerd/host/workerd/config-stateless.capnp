using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [
		(name = "stateless", worker = (
			compatibilityDate = "2025-08-08",
			compatibilityFlags = ["experimental"],
			modules = [(name = "stateless-worker.js", esModule = embed "stateless-worker.js")],
			bindings = [
				(name = "RIVET_WORKERD_TOKEN", text = "dev-only-change-me"),
				(name = "RIVET_OBJECT_ROUTER_TOKEN", text = "object-router-token-change-me"),
				(name = "WORKER_LOADER", workerLoader = (id = "rivet-stateless-worker-versions")),
				(name = "WORKER_CODE", service = "worker-code"),
				(name = "OBJECT_ROUTER", service = "object-router"),
			],
		)),
		(name = "worker-code", external = (address = "127.0.0.1:19084", http = ())),
		(name = "object-router", external = (address = "127.0.0.1:19085", http = ())),
	],
	sockets = [
		(name = "http", address = "127.0.0.1:18090", http = (), service = "stateless"),
	],
);
