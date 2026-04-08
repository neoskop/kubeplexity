import pc from "picocolors";

const POD_COLORS = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue, pc.red];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function colorPodName(name) {
  if (!name) return pc.dim("unknown");
  const colorFn = POD_COLORS[hashString(name) % POD_COLORS.length];
  return colorFn(name);
}

export function formatAddress(addr) {
  return `${addr.address} ${pc.dim("(")}${colorPodName(addr.name)}${pc.dim(")")}`;
}

export function formatJson(value) {
  if (value === undefined || value === null) return pc.dim("(empty)");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export const log = {
  info(msg) {
    console.log(`${pc.blue("INFO")}  ${msg}`);
  },
  warn(msg) {
    console.warn(`${pc.yellow("WARN")}  ${msg}`);
  },
  error(msg) {
    console.error(`${pc.red("ERROR")} ${msg}`);
  },
};
