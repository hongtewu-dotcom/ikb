import { join, resolve } from "node:path";

export function evalPlaneRoot(): string {
  const ikbRoot = resolve(process.env.IKB_PROJECT_ROOT ?? process.cwd());
  return resolve(process.env.IKB_EVAL_PLANE_ROOT ?? join(ikbRoot, "projects", "eval-plane"));
}
