import express from "express";
import axios from "axios";
import dns from "dns/promises";
import axiosRetry from "axios-retry";
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

const axiosClient = axios.create({
  timeout: 10000,
});

axiosRetry(axiosClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    if (error?.response?.status === 408) {
      return true;
    }

    return axiosRetry.isNetworkOrIdempotentRequestError(error);
  },
  onRetry: (retryCount, error, requestConfig) => {
    const url = requestConfig?.url ?? "unknown";
    console.log(`Retrying request to ${url} (attempt ${retryCount})`);
    if (error?.message) {
      console.log(`Retry triggered by error: ${error.message}`);
    }
  },
});

const app = express();
const port = 8080;

console.log(`Starting kubeplexity v${appVersion}`);

const getTargetParts = () => {
  const target = process.env.TARGET;

  if (!target) {
    throw new Error("TARGET environment variable must be set");
  }

  if (target.includes(":")) {
    const parts = target.split(":");
    return { targetHostname: parts[0], targetPort: parts[1] };
  } else {
    return { targetHostname: target, targetPort: 80 };
  }
};

let targetHostname;
let targetPort;

try {
  ({ targetHostname, targetPort } = getTargetParts());
} catch (error) {
  console.error(`Invalid target configuration: ${error?.message ?? error}`);
  process.exit(1);
}

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

const prepareForwardHeaders = (headers, body) => {
  const forwardHeaders = { ...headers };

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

  try {
    const response = await axiosClient.request({
      method: req.method,
      url,
      headers: prepareForwardHeaders(req.headers, body),
      data: body,
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
    if (error?.response?.status) {
      console.error(
        `Error forwarding request to ${url}: received status ${error.response.status}`
      );
      return {
        url,
        address: address.address,
        status: error.response.status,
        success: false,
        error: `Received status ${error.response.status}`,
      };
    }

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
    addresses = await dns.lookup(targetHostname, { family: 4, all: true });
  } catch (error) {
    console.error(`Resolving of ${targetHostname} failed: ${error}`);
    res.status(502).send("Failed to resolve target host");
    return;
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    console.error(`No IPv4 addresses found for ${targetHostname}`);
    res.status(502).send("No targets resolved for host");
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
