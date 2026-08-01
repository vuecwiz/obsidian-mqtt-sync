import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export async function installTestVault() {
  const vault = resolve(process.env.OBSIDIAN_MQTT_TEST_VAULT ?? join(homedir(), "vanotes-test"));
  const liveVault = resolve(join(homedir(), "vanotes"));
  if (vault === liveVault || !/test/i.test(basename(vault))) {
    throw new Error("Refusing to install outside an explicitly named test Vault");
  }
  await stat(join(vault, ".obsidian"));
  await stat("main.js");
  const destination = join(vault, ".obsidian", "plugins", "mqtt-sync");
  await mkdir(destination, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    await copyFile(file, join(destination, file));
  }
  return { vault, destination, vaultName: basename(vault) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installTestVault()
    .then(({ vaultName }) => {
      process.stdout.write(JSON.stringify({ installed: true, vault: vaultName }) + "\n");
    })
    .catch((error) => {
      process.stderr.write(`install-test-vault: ${error.message}\n`);
      process.exitCode = 1;
    });
}
