# kubeplexity

## Quickstart

```bash
$ ./scripts/quickstart.sh
$ curl http://127.0.0.1:8080/foo
Ok
```

## Operational endpoints

Two auxiliary endpoints are exposed to help validate which build is running and whether the service is accepting traffic:

| Endpoint | Description |
| --- | --- |
| `GET /__version` | Returns the semantic version string read from `package.json`. |
| `GET /__health` | Lightweight health probe including the current version. |
