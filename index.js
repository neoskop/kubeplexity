import express from "express";
import * as k8s from "@kubernetes/client-node";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

import { createPodDiscovery } from "./src/discovery.js";
import { createRequestForwarder, readRequestBody } from "./src/forwarding.js";
import { log, formatJson } from "./src/logger.js";

const resolvePackageJsonPath = () => {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  return path.join(currentDir, "package.json");
};

let appVersion = "unknown";

const loadAppVersion = async () => {
  try {
    const packageJsonPath = resolvePackageJsonPath();
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(packageJsonContent);
    if (parsed?.version && typeof parsed.version === "string") {
      appVersion = parsed.version;
    }
  } catch (error) {
    log.warn(`Failed to read package.json: ${error?.message ?? error}`);
  }
};

await loadAppVersion();

const app = express();
app.use(express.raw({ type: "*/*" }));
const port = 8080;

log.info(`${pc.bold("kubeplexity")} ${pc.dim("v" + appVersion)}`);

const parseTarget = () => {
  const target = process.env.TARGET;

  if (!target) {
    throw new Error("TARGET environment variable must be set");
  }

  const match = target.match(
    /^(deployment|statefulset|service)\/([^:]+?)(?::(\d+))?$/
  );

  if (!match) {
    throw new Error(
      `Invalid TARGET format: "${target}". ` +
        `Expected "deployment/<name>[:<port>]", "statefulset/<name>[:<port>]", or "service/<name>[:<port>]". ` +
        `Example: "deployment/echo:80"`
    );
  }

  return {
    workloadKind: match[1],
    workloadName: match[2],
    targetPort: match[3] ? parseInt(match[3], 10) : 80,
  };
};

let workloadKind;
let workloadName;
let targetPort;

try {
  ({ workloadKind, workloadName, targetPort } = parseTarget());
} catch (error) {
  log.error(`Invalid target configuration: ${error?.message ?? error}`);
  process.exit(1);
}

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const appsApi = kc.makeApiClient(k8s.AppsV1Api);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);

const resolveNamespace = async () => {
  if (process.env.NAMESPACE) {
    return process.env.NAMESPACE;
  }
  try {
    const ns = await readFile(
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
      "utf-8"
    );
    return ns.trim();
  } catch {
    throw new Error(
      "Unable to determine namespace. Set NAMESPACE env var or run in-cluster."
    );
  }
};

let namespace;

try {
  namespace = await resolveNamespace();
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

log.info(`Target: ${pc.bold(workloadKind + "/" + workloadName + ":" + targetPort)} in ${pc.cyan(namespace)}`);

const getAddresses = createPodDiscovery({
  appsApi,
  coreApi,
  config: { workloadKind, workloadName, namespace },
  cacheTtlMs: parseInt(process.env.DISCOVERY_INTERVAL_MS ?? "5000", 10),
});

const forwardRequestToAddress = createRequestForwarder({ targetPort });

app.get("/__version", (req, res) => {
  res.json({ version: appVersion });
});

app.get("/__health", (req, res) => {
  res.json({ status: "ok", version: appVersion });
});

app.use(async (req, res) => {
  let addresses;

  try {
    addresses = await getAddresses();
  } catch (error) {
    log.error(`Pod discovery failed for ${pc.bold(workloadKind + "/" + workloadName)}: ${error}`);
    res.status(502).send("Failed to discover target pods");
    return;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    log.error(`No ready pods for ${pc.bold(workloadKind + "/" + workloadName)} in ${pc.cyan(namespace)}`);
    res.status(502).send("No ready pods found for target workload");
    return;
  }

  let body;

  try {
    body = await readRequestBody(req);
  } catch (error) {
    res.status(500).send("Failed to read request body");
    return;
  }

  const results = await Promise.all(
    addresses.map((address) => forwardRequestToAddress(req, address, body))
  );

  const successes = results.filter((result) => result.success);
  const failures = results.filter((result) => !result.success);

  if (successes.length === 0) {
    log.error(`All forwards failed for ${pc.bold(req.method)} ${req.url}`);
    log.error(formatJson(failures));
    res.status(502).send("Failed to forward request to any resolved target");
    return;
  }

  if (failures.length > 0) {
    log.warn(`Partial failures for ${pc.bold(req.method)} ${req.url}`);
    log.warn(formatJson(failures));
  }

  res.send("Ok");
});

app.listen(port, () => {
  log.info(`Listening on port ${pc.bold(port)}`);
});
