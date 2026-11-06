using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "public-egress", worker = (
      compatibilityDate = "2026-09-30",
      compatibilityFlags = ["global_fetch_strictly_public"],
      modules = [(name = "worker.mjs", esModule = embed "workerd-public-egress.mjs")],
      globalOutbound = "internet"
    )),
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true)))
  ]
);
