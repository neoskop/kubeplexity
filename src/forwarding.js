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

export const fetchWithRetry = async (url, options, { retries = 3, timeout = 10000 } = {}) => {
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

export const readRequestBody = async (req) => {
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

export const prepareForwardHeaders = (headers, body) => {
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
};
