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

  if (hasContent(req.body)) return req.body;

  if (!req.readable || req.readableEnded) return undefined;

  try {
    return await readStream(req);
  } catch (error) {
    console.error(`Failed to read request body: ${error}`);
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
    console.log(`Forwarding request to ${url}`);

    let fetchBody = body;
    if (body !== undefined && body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      fetchBody = JSON.stringify(body);
    }

    try {
      const response = await fetchWithRetry(url, {
        method: req.method,
        headers: prepareForwardHeaders(req.headers, fetchBody),
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
};
