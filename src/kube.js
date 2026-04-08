import https from "node:https";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

async function loadInClusterConfig() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || "443";

  if (!host) throw new Error("KUBERNETES_SERVICE_HOST not set");

  const token = (await readFile(SA_TOKEN_PATH, "utf-8")).trim();
  const ca = await readFile(SA_CA_PATH);

  return { server: `https://${host}:${port}`, token, ca };
}

async function loadKubeConfigFromFile() {
  const configPath =
    process.env.KUBECONFIG ||
    resolve(process.env.HOME || "~", ".kube", "config");
  const raw = parseYaml(await readFile(configPath, "utf-8"));

  const ctx = raw.contexts?.find(
    (c) => c.name === raw["current-context"]
  )?.context;
  if (!ctx) throw new Error(`Context "${raw["current-context"]}" not found`);

  const cluster = raw.clusters?.find((c) => c.name === ctx.cluster)?.cluster;
  if (!cluster) throw new Error(`Cluster "${ctx.cluster}" not found`);

  const user = raw.users?.find((u) => u.name === ctx.user)?.user;

  const result = { server: cluster.server };

  if (cluster["certificate-authority-data"]) {
    result.ca = Buffer.from(cluster["certificate-authority-data"], "base64");
  } else if (cluster["certificate-authority"]) {
    result.ca = await readFile(cluster["certificate-authority"]);
  }

  if (user?.token) {
    result.token = user.token;
  } else if (user?.["client-certificate-data"] && user?.["client-key-data"]) {
    result.cert = Buffer.from(user["client-certificate-data"], "base64");
    result.key = Buffer.from(user["client-key-data"], "base64");
  } else if (user?.["client-certificate"] && user?.["client-key"]) {
    result.cert = await readFile(user["client-certificate"]);
    result.key = await readFile(user["client-key"]);
  }

  return result;
}

export async function loadConfig() {
  try {
    return await loadInClusterConfig();
  } catch {
    return await loadKubeConfigFromFile();
  }
}

function request(config, method, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathAndQuery, config.server);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { Accept: "application/json" },
    };

    if (config.token) opts.headers.Authorization = `Bearer ${config.token}`;
    if (config.ca) opts.ca = config.ca;
    if (config.cert) opts.cert = config.cert;
    if (config.key) opts.key = config.key;

    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Invalid JSON from K8s API: ${body.slice(0, 200)}`));
          }
        } else {
          reject(
            new Error(
              `K8s API ${method} ${url.pathname}: ${res.statusCode} ${body.slice(0, 200)}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

export function createAppsV1Api(config) {
  return {
    readNamespacedDeployment: ({ name, namespace }) =>
      request(config, "GET", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}`),
    readNamespacedStatefulSet: ({ name, namespace }) =>
      request(config, "GET", `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets/${encodeURIComponent(name)}`),
  };
}

export function createCoreV1Api(config) {
  return {
    readNamespacedService: ({ name, namespace }) =>
      request(config, "GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`),
    listNamespacedPod: ({ namespace, labelSelector }) => {
      const params = new URLSearchParams();
      if (labelSelector) params.set("labelSelector", labelSelector);
      return request(config, "GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${params}`);
    },
  };
}
