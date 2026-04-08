import pc from "picocolors";
import { log, formatAddress, formatJson } from "./logger.js";

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

const fetchWithRetry = async (url, options, address, { retries = 3, timeout = 10000 } = {}) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeout),
      });

      if (response.status === 408 && attempt < retries) {
        const delay = Math.pow(2, attempt + 1) * 100 + Math.random() * 100;
        log.warn(`RETRY ${formatAddress(address)} attempt ${attempt + 1}/${retries} -- Request Timeout (408)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      if (attempt < retries) {
        const delay = Math.pow(2, attempt + 1) * 100 + Math.random() * 100;
        const reason = error?.message ?? String(error);
        log.warn(`RETRY ${formatAddress(address)} attempt ${attempt + 1}/${retries} -- ${reason}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
};

const hasContent = (body) => {
  if (body === undefined || body === null) return false;
  if (Buffer.isBuffer(body)) return true;
  if (typeof body === "string") return body.length > 0;
  if (typeof body === "object") return Object.keys(body).length > 0;
  return false;
};

const readStream = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
};

export const readRequestBody = async (req) => {
  const method = req.method?.toUpperCase?.() ?? "";
  if (method === "GET" || method === "HEAD") return undefined;

  if (hasContent(req.body)) {
    return req.body;
  }

  if (!req.readable || req.readableEnded) {
    return undefined;
  }

  try {
    return await readStream(req);
  } catch (error) {
    log.error(`Failed to read request body: ${error}`);
    throw error;
  }
};

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

export const createRequestForwarder = ({ targetPort }) => {
  return async (req, address, body) => {
    const url = `http://${address.address}:${targetPort}${req.url}`;

    log.info(`FWD ${pc.bold(req.method)} ${req.url} -> ${formatAddress(address)}`);

    let fetchBody = body;
    if (body !== undefined && body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      fetchBody = JSON.stringify(body);
    }

    const forwardHeaders = prepareForwardHeaders(req.headers, fetchBody);

    if (process.env.DEBUG) {
      log.info(`  headers: ${formatJson(forwardHeaders)}`);
      if (fetchBody !== undefined && fetchBody !== null) {
        const bodyStr = Buffer.isBuffer(fetchBody) ? fetchBody.toString("utf-8") : String(fetchBody);
        log.info(`  body: ${formatJson(bodyStr)}`);
      }
    }

    try {
      const response = await fetchWithRetry(url, {
        method: req.method,
        headers: forwardHeaders,
        body: fetchBody,
      }, address);

      if (response.status >= 200 && response.status < 400) {
        log.info(` OK ${pc.bold(req.method)} ${req.url} -> ${formatAddress(address)} ${pc.green(response.status)}`);
      } else {
        log.warn(`ERR ${pc.bold(req.method)} ${req.url} -> ${formatAddress(address)} ${pc.red(response.status)}`);
      }

      return {
        url,
        address: address.address,
        status: response.status,
        success: response.status >= 200 && response.status < 400,
      };
    } catch (error) {
      log.error(`FAIL ${pc.bold(req.method)} ${req.url} -> ${formatAddress(address)}: ${error?.message ?? error}`);
      return {
        url,
        address: address.address,
        success: false,
        error: error?.message ?? String(error),
      };
    }
  };
};
