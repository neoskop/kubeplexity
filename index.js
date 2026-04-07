import express from "express";
import * as k8s from "@kubernetes/client-node";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

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

const fetchWithRetry = async (url, options, { retries = 3, timeout = 10000 } = {}) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status === 408 && attempt < retries) {
        const delay = Math.pow(2, attempt + 1) * 100 + Math.random() * 100;
        console.log(`Retrying request to ${url} (attempt ${attempt + 1})`);
        console.log(`Retry triggered by error: Request Timeout (408)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt + 1) * 100 + Math.random() * 100;
        console.log(`Retrying request to ${url} (attempt ${attempt + 1})`);
        if (error?.message) {
          console.log(`Retry triggered by error: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
};

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

const discoverPodAddresses = async () => {
  let selector;

  if (workloadKind === "deployment") {
    const deployment = await appsApi.readNamespacedDeployment({
      name: workloadName,
      namespace,
    });
    selector = deployment.spec?.selector?.matchLabels;
  } else {
    const statefulSet = await appsApi.readNamespacedStatefulSet({
      name: workloadName,
      namespace,
    });
    selector = statefulSet.spec?.selector?.matchLabels;
  }

  if (!selector || Object.keys(selector).length === 0) {
    throw new Error(
      `No matchLabels found on ${workloadKind}/${workloadName}`
    );
  }

  const labelSelector = Object.entries(selector)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  const podList = await coreApi.listNamespacedPod({
    namespace,
    labelSelector,
  });

  const readyPods = podList.items.filter((pod) => {
    if (pod.status?.phase !== "Running") return false;
    if (!pod.status?.podIP) return false;

    const readyCondition = pod.status?.conditions?.find(
      (c) => c.type === "Ready"
    );
    return readyCondition?.status === "True";
  });

  return readyPods.map((pod) => ({
    address: pod.status.podIP,
    name: pod.metadata?.name,
  }));
};

let cachedAddresses = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = parseInt(
  process.env.DISCOVERY_INTERVAL_MS ?? "5000",
  10
);

const getAddresses = async () => {
  const now = Date.now();
  if (cachedAddresses && now < cacheExpiry) {
    return cachedAddresses;
  }
  cachedAddresses = await discoverPodAddresses();
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedAddresses;
};

const readRequestBody = async (req) => {
  const method = req.method?.toUpperCase?.() ?? "";

  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === "string" && req.body.length > 0) {
      return req.body;
    }

    if (typeof req.body === "object" && Object.keys(req.body).length > 0) {
      return req.body;
    }
  }

  if (!req.readable || req.readableEnded) {
    return undefined;
  }

  const chunks = [];

  try {
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    console.error(`Failed to read request body: ${error}`);
    throw error;
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return Buffer.concat(chunks);
};

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const prepareForwardHeaders = (headers, body) => {
  const forwardHeaders = { ...headers };

  for (const header of HOP_BY_HOP_HEADERS) {
    delete forwardHeaders[header];
  }

  delete forwardHeaders["host"];

  if (body === undefined || body === null) {
    delete forwardHeaders["content-length"];
  } else if (Buffer.isBuffer(body) || typeof body === "string") {
    forwardHeaders["content-length"] = Buffer.byteLength(body).toString();
  } else {
    delete forwardHeaders["content-length"];
  }

  return forwardHeaders;
};

const forwardRequestToAddress = async (req, address, body) => {
  const url = `http://${address.address}:${targetPort}${req.url}`;
  console.log(`Forwarding request to ${url}`);

  let fetchBody = body;
  if (body !== undefined && body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
    fetchBody = JSON.stringify(body);
  }

  try {
    const response = await fetchWithRetry(url, {
      method: req.method,
      headers: prepareForwardHeaders(req.headers, body),
      body: fetchBody,
    });

    if (response.status < 200 || response.status >= 400) {
      console.warn(
        `Received status code ${response.status} when forwarding request to ${url}`
      );
    }

    return {
      url,
      address: address.address,
      status: response.status,
      success: response.status >= 200 && response.status < 400,
    };
  } catch (error) {
    console.error(`Error forwarding request to ${url}: ${error}`);
    return {
      url,
      address: address.address,
      success: false,
      error: error?.message ?? String(error),
    };
  }
};

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
