import { expect, it } from "bun:test";

/** #570: a process that never ran the startup version probe must keep untrusted routes on print. */
it("pty isolation is OFF in a fresh process that never probed (fail closed)", () => {
  const probe = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { engines } from "./src/oneshot/registry.js"; import { resolveOneShotEngine } from "./src/oneshot/config.js";
       console.log(JSON.stringify({ iso: engines.get("pty").caps.isolation,
         route: resolveOneShotEngine({ engines: {}, routes: {} }, "discord.classifier", true) }));`,
    ],
    { cwd: process.cwd() },
  );
  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString().trim())).toEqual({ iso: false, route: "print" });
});
