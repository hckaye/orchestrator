import path from "node:path";
import { fileURLToPath } from "node:url";

export function moduleDirectory(moduleUrl) {
  return path.dirname(fileURLToPath(moduleUrl));
}
