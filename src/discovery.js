export const createPodDiscovery = ({ appsApi, coreApi, config, cacheTtlMs = 5000 }) => {
  const { workloadKind, workloadName, namespace } = config;

  let cachedAddresses = null;
  let cacheExpiry = 0;

  const discoverPodAddresses = async () => {
    let selector;

    if (workloadKind === "deployment") {
      const deployment = await appsApi.readNamespacedDeployment({
        name: workloadName,
        namespace,
      });
      selector = deployment.spec?.selector?.matchLabels;
    } else {
      const statefulSet = await appsApi.readNamespacedStatefulSet({
        name: workloadName,
        namespace,
      });
      selector = statefulSet.spec?.selector?.matchLabels;
    }

    if (!selector || Object.keys(selector).length === 0) {
      throw new Error(
        `No matchLabels found on ${workloadKind}/${workloadName}`
      );
    }

    const labelSelector = Object.entries(selector)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");

    const podList = await coreApi.listNamespacedPod({
      namespace,
      labelSelector,
    });

    const readyPods = podList.items.filter((pod) => {
      if (pod.status?.phase !== "Running") return false;
      if (!pod.status?.podIP) return false;

      const readyCondition = pod.status?.conditions?.find(
        (c) => c.type === "Ready"
      );
      return readyCondition?.status === "True";
    });

    return readyPods.map((pod) => ({
      address: pod.status.podIP,
      name: pod.metadata?.name,
    }));
  };

  return async () => {
    const now = Date.now();
    if (cachedAddresses && now < cacheExpiry) {
      return cachedAddresses;
    }
    cachedAddresses = await discoverPodAddresses();
    cacheExpiry = now + cacheTtlMs;
    return cachedAddresses;
  };
};
