import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { z } from "zod";

const localProjectSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(120),
  memberId: z.string().uuid(),
  memberName: z.string().min(1).max(120),
  role: z.enum(["HOST", "MEMBER", "AGENT"]),
  machineId: z.string().uuid(),
  databaseUrl: z.string().url().startsWith("postgresql://"),
  valkeyUrl: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    ),
});

export type LocalProject = z.infer<typeof localProjectSchema>;
export interface ProjectLocation {
  root: string;
  config: LocalProject;
}

const CONFIG_DIRECTORY = ".jobsmith";
const CONFIG_FILE = "config.json";

export async function findLocalProject(
  start = process.cwd(),
): Promise<ProjectLocation> {
  let directory = resolve(start);
  while (true) {
    const path = join(directory, CONFIG_DIRECTORY, CONFIG_FILE);
    const file = Bun.file(path);
    if (await file.exists()) {
      const parsed = localProjectSchema.safeParse(
        JSON.parse(await file.text()),
      );
      if (!parsed.success)
        throw new Error(`Invalid Jobsmith configuration at ${path}`);
      return { root: directory, config: parsed.data };
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root) break;
    directory = parent;
  }
  throw new Error("This folder is not initialized. Run `jobsmith init` first.");
}

export async function writeLocalProject(
  root: string,
  config: LocalProject,
): Promise<void> {
  const parsed = localProjectSchema.parse(config);
  const directory = join(resolve(root), CONFIG_DIRECTORY);
  const path = join(directory, CONFIG_FILE);
  if (await Bun.file(path).exists())
    throw new Error("This folder is already initialized for Jobsmith");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await Bun.write(path, `${JSON.stringify(parsed, null, 2)}\n`);
  await chmod(directory, 0o700);
  await chmod(path, 0o600);
}

export async function localProjectExists(
  root = process.cwd(),
): Promise<boolean> {
  try {
    await readFile(join(resolve(root), CONFIG_DIRECTORY, CONFIG_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeLocalProject(root: string): Promise<void> {
  const directory = join(resolve(root), CONFIG_DIRECTORY);
  const configPath = join(directory, CONFIG_FILE);
  if (!(await Bun.file(configPath).exists()))
    throw new Error("This folder is not initialized for Jobsmith");
  await rm(directory, { recursive: true, force: false });
}
