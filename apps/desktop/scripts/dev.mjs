// `pnpm dev` wrapper. VS Code's extension host (and tools spawned from it,
// e.g. the Claude Code terminal) runs as Electron-in-Node mode and leaks
// ELECTRON_RUN_AS_NODE=1 into child shells. With that set, the Electron binary
// electron-vite spawns boots as plain Node: `require("electron")` returns the
// package's path string, `protocol` is undefined, and the app dies at
// registerSchemesAsPrivileged. Strip it (and the related Node-only flag) so
// the dev loop works from any terminal.
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn("electron-vite", ["dev", ...process.argv.slice(2)], {
	stdio: "inherit",
	env,
	shell: process.platform === "win32",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
