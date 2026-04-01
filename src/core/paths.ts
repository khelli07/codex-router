import path from "node:path";

export interface RouterLayout {
  routerHome: string;
  sharedDir: string;
  accountsDir: string;
  runtimeDir: string;
  runtimeCurrentHomeDir: string;
  stateDir: string;
  registryPath: string;
}

export function getRouterLayout(routerHome: string): RouterLayout {
  const sharedDir = path.join(routerHome, "shared");
  const accountsDir = path.join(routerHome, "accounts");
  const runtimeDir = path.join(routerHome, "runtime");
  const stateDir = path.join(routerHome, "state");

  return {
    routerHome,
    sharedDir,
    accountsDir,
    runtimeDir,
    runtimeCurrentHomeDir: path.join(runtimeDir, "current-home"),
    stateDir,
    registryPath: path.join(stateDir, "accounts.json"),
  };
}
