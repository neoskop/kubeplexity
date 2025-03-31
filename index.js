import express from "express";
import axios from "axios";
import dns from "dns";
import axiosRetry from "axios-retry";

axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const app = express();
const port = 8080;

const getTargetParts = () => {
  const target = process.env.TARGET;

  if (target.includes(":")) {
    const parts = target.split(":");
    return { targetHostname: parts[0], targetPort: parts[1] };
  } else {
    return { targetHostname: target, targetPort: 80 };
  }
};

const { targetHostname, targetPort } = getTargetParts();

app.all("/*", (req, res) => {
  dns.lookup(
    targetHostname,
    { family: 4, all: true },
    async (err, addresses) => {
      if (err) {
        console.error(`Resolving of ${targetHostname} failed: ${err}`);
        return;
      }

      await Promise.all(
        addresses.map(async (address) => {
          const url = `http://${address.address}:${targetPort}${req.url}`;
          console.log(`Forwarding request to ${url}`);
          try {
            await axios.request({
              method: req.method,
              url,
              headers: req.headers,
              data: req.body,
              onRetry: (retryCount) => {
                console.log(
                  `Retrying request to ${url} (attempt ${retryCount})`
                );
              },
            });
          } catch (error) {
            console.error(`Error forwarding request to ${url}: ${error}`);
          }
        })
      );
    }
  );

  res.send("Ok");
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
