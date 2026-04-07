import express from "express";
import * as k8s from "@kubernetes/client-node";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { createPodDiscovery } from "./src/discovery.js";
import { createRequestForwarder, readRequestBody } from "./src/forwarding.js";

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
    console.warn(
      `Failed to read package.json for version information: ${error?.message ?? error}`
    );
  }
};

await loadAppVersion();

const app = express();
const port = 8080;

console.log(`Starting kubeplexity v${appVersion}`);

const parseTarget = () => {
  const target = process.env.TARGET;

  if (!target) {
    throw new Error("TARGET environment variable must be set");
  }

  const match = target.match(
    /^(deployment|statefulset)\/([^:]+?)(?::(\d+))?$/
  );

  if (!match) {
    throw new Error(
      `Invalid TARGET format: "${target}". ` +
        `Expected "deployment/<name>[:<port>]" or "statefulset/<name>[:<port>]". ` +
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
  console.error(`Invalid target configuration: ${error?.message ?? error}`);
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
  console.error(error.message);
  process.exit(1);
}

console.log(
  `Targeting ${workloadKind}/${workloadName}:${targetPort} in namespace ${namespace}`
);

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
    console.error(
      `Pod discovery for ${workloadKind}/${workloadName} failed: ${error}`
    );
    res.status(502).send("Failed to discover target pods");
    return;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    console.error(
      `No ready pods found for ${workloadKind}/${workloadName} in namespace ${namespace}`
    );
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
    console.error(
      `Failed to forward ${req.method} ${req.url} to any resolved target. Failures: ${JSON.stringify(
        failures
      )}`
    );
    res.status(502).send("Failed to forward request to any resolved target");
    return;
  }

  if (failures.length > 0) {
    console.warn(
      `Completed ${req.method} ${req.url} with partial failures: ${JSON.stringify(
        failures
      )}`
    );
  }

  res.send("Ok");
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
