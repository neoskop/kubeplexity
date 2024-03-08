#!/bin/bash

reg_name='kind-registry-kubeplexity'
reg_port='5000'

setup_registry() {
  running="$(docker inspect -f '{{.State.Running}}' "${reg_name}" 2>/dev/null || true)"
  state=$(docker container ls -a -f name=$reg_name --format="{{.State}}")
  if [ -z "$state" ]; then
    docker run \
      -d --restart=always -p "127.0.0.1:${reg_port}:5000" --name "${reg_name}" \
      registry:2 &>/dev/null
  elif [ "$state" != "running" ]; then
    docker start "${reg_name}" &>/dev/null
  fi
}

setup_registry

# Setup kind cluster
if ! kind get clusters | grep -o kubeplexity &>/dev/null; then
  local_dir=$(pwd)
  cat <<EOF | kind create cluster --name kubeplexity --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."localhost:${reg_port}"]
    endpoint = ["http://${reg_name}:${reg_port}"]
nodes:
- role: control-plane
  extraPortMappings:
  - containerPort: 30001
    hostPort: 8080
    listenAddress: "127.0.0.1"
  extraMounts:
  - hostPath: ${local_dir}
    containerPath: /kubeplexity
EOF

  docker network connect "kind" "${reg_name}" || true

  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${reg_port}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF
fi

kubectl config use-context kind-kubeplexity &>/dev/null

docker build -t localhost:${reg_port}/kubeplexity:latest .
docker push localhost:${reg_port}/kubeplexity:latest

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: kubeplexity
spec:
  type: NodePort
  selector:
    app: kubeplexity
  ports:
    - protocol: TCP
      nodePort: 30001
      port: 30001
      targetPort: 8080
EOF

cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeplexity
  labels:
    app: kubeplexity
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kubeplexity
  template:
    metadata:
      name: kubeplexity
      labels:
        app: kubeplexity
    spec:
      containers:
        - name: kubeplexity
          imagePullPolicy: Always
          image: localhost:${reg_port}/kubeplexity:latest
          env:
            - name: TARGET
              value: echo
          ports:
            - containerPort: 8080
              name: http
EOF

cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: echo
spec:
  clusterIP: None
  selector:
    app: echo
  ports:
    - protocol: TCP
      port: 80
      targetPort: 80
EOF

cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: echo
  labels:
    app: echo
spec:
  replicas: 2
  selector:
    matchLabels:
      app: echo
  template:
    metadata:
      name: echo
      labels:
        app: echo
    spec:
      containers:
        - name: echo
          image: ealen/echo-server:0.9.2
          ports:
            - containerPort: 80
              name: http
EOF

kubectl rollout restart deploy/kubeplexity
