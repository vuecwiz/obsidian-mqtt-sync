import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
const FORCE_KILL_DELAY_MS = 1_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const COMMAND_SETTLE_DELAY_MS = 75;

export class ObsidianCliTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`Obsidian CLI ${operation} timed out after ${timeoutMs}ms`);
    this.name = "ObsidianCliTimeoutError";
  }
}

export function runObsidianCli(vaultName, args, options = {}) {
  if (vaultName !== "vanotes-test") {
    throw new Error("Obsidian automation is restricted to the explicit vanotes-test Vault");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const operation = args[0] ?? "unknown";
  const timeoutError = new ObsidianCliTimeoutError(operation, timeoutMs);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "obsidian",
      [`vault=${vaultName}`, ...args],
      { maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        clearTimeout(forceKillHandle);
        if (error) {
          if (timedOut) {
            rejectPromise(timeoutError);
          } else {
            rejectPromise(error);
          }
          return;
        }
        const output = `${stdout}${stderr}`;
        const rejectOutputErrors =
          options.rejectOutputErrors ?? !["dev:errors", "dev:console"].includes(operation);
        if (rejectOutputErrors && (/^Error:/mu.test(output) || /exceptionDetails/u.test(output))) {
          rejectPromise(new Error(`Obsidian CLI ${operation} reported an evaluation error`));
          return;
        }
        setTimeout(() => resolvePromise(output), COMMAND_SETTLE_DELAY_MS);
      },
    );
    let timedOut = false;
    let forceKillHandle;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillHandle = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
      forceKillHandle.unref();
    }, timeoutMs);
    timeoutHandle.unref();
  });
}
