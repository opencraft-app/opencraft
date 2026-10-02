using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [
		(name = "actors", worker = (
			compatibilityDate = "2025-08-08",
			compatibilityFlags = ["unsafe_module", "experimental"],
			modules = [(name = "worker.js", esModule = embed "worker.js")],
			bindings = [
				(name = "ACTOR", durableObjectNamespace = "RivetActor"),
				(name = "RIVET_WORKERD_TOKEN", text = "dev-only-change-me"),
				(name = "WORKER_LOADER", workerLoader = (id = "rivet-worker-versions")),
				(name = "WORKER_CODE", service = "worker-code"),
			],
			durableObjectNamespaces = [
				(className = "RivetActor", uniqueKey = "rivet-workerd-v1", enableSql = true),
			],
			durableObjectStorage = (localDisk = "actor-cache"),
		)),
		(name = "actor-cache", disk = (path = "var/rivet-workerd", writable = true)),
		(name = "worker-code", external = (address = "127.0.0.1:19083", http = ())),
	],
	sockets = [
		(name = "http", address = "127.0.0.1:8080", http = (), service = "actors"),
	],
);
