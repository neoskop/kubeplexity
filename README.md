# kubeplexity

Kubernetes request multiplexer -- forwards incoming HTTP requests to **all pods** of a target Deployment, StatefulSet, or Service in parallel.

Pod discovery uses the Kubernetes API directly (via `@kubernetes/client-node`), so no headless Service is needed.

## Configuration

| Environment variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TARGET` | yes | -- | Target workload: `deployment/<name>[:<port>]`, `statefulset/<name>[:<port>]`, or `service/<name>[:<port>]`. Port defaults to `80`. |
| `NAMESPACE` | no | auto-detected | Kubernetes namespace. Auto-detected from the in-cluster service account when omitted. |
| `DISCOVERY_INTERVAL_MS` | no | `5000` | How often (in ms) to re-query the Kubernetes API for pod addresses. |

### Examples

```
TARGET=deployment/echo            # all pods of Deployment "echo", port 80
TARGET=deployment/echo:8080       # all pods of Deployment "echo", port 8080
TARGET=statefulset/redis:6379     # all pods of StatefulSet "redis", port 6379
TARGET=service/my-service:8080    # all pods behind Service "my-service", port 8080
```

## RBAC

kubeplexity needs a ServiceAccount with permission to **read the target workload** and **list its pods**.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeplexity
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kubeplexity
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kubeplexity
subjects:
  - kind: ServiceAccount
    name: kubeplexity
roleRef:
  kind: Role
  name: kubeplexity
  apiGroup: rbac.authorization.k8s.io
```

Then reference the ServiceAccount in your Deployment/Pod spec:

```yaml
spec:
  template:
    spec:
      serviceAccountName: kubeplexity
```

> **Note:** The Role above is namespace-scoped. If kubeplexity needs to target workloads across namespaces, use a ClusterRole and ClusterRoleBinding instead.

## Quickstart

```bash
$ ./scripts/quickstart.sh
$ curl http://127.0.0.1:8080/foo
Ok
```

## Operational endpoints

| Endpoint | Description |
| --- | --- |
| `GET /__version` | Returns the semantic version string read from `package.json`. |
| `GET /__health` | Lightweight health probe including the current version. |
