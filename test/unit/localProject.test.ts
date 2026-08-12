import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findLocalProject,
  localProjectExists,
  removeLocalProject,
  writeLocalProject,
  type LocalProject,
} from "../../src/project/localConfig.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local project configuration", () => {
  test("writes private configuration and discovers it from a child folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobsmith-test-"));
    directories.push(root);
    const config: LocalProject = {
      schemaVersion: 1,
      projectId: crypto.randomUUID(),
      projectName: "Example",
      memberId: crypto.randomUUID(),
      memberName: "Ada",
      role: "HOST",
      machineId: crypto.randomUUID(),
      databaseUrl: "postgresql://user:pass@localhost/jobsmith",
      valkeyUrl: "redis://localhost:6379",
    };
    await writeLocalProject(root, config);
    const child = join(root, "src", "nested");
    await mkdir(child, { recursive: true });
    expect(await localProjectExists(root)).toBe(true);
    expect((await findLocalProject(child)).config).toEqual(config);
    expect(
      (await stat(join(root, ".jobsmith", "config.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(writeLocalProject(root, config)).rejects.toThrow(
      "already initialized",
    );
    await removeLocalProject(root);
    expect(await localProjectExists(root)).toBe(false);
    await writeLocalProject(root, config);
    expect(await localProjectExists(root)).toBe(true);
  });
});
