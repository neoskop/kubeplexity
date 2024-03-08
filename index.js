import express from "express";
import axios from "axios";
import dns from "dns";

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
        console.error(err);
      }

      await Promise.all(
        addresses.map((address) => {
          console.log(
            `Forwarding request to http://${address.address}:${targetPort}${req.url}`
          );
          return axios.request({
            method: req.method,
            url: `http://${address.address}:${targetPort}${req.url}`,
            headers: req.headers,
            data: req.body,
          });
        })
      );
    }
  );

  res.send("Ok");
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
