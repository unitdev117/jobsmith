import Redis from "ioredis";
import type { Logger } from "pino";
import {
  parsePresence,
  presencePattern,
  type PresencePayload,
} from "./valkey.ts";

export interface PresenceEntry extends PresencePayload {
  memberId: string;
}

export async function readPresence(
  valkeyUrl: string,
  projectId: string,
  log: Logger,
): Promise<PresenceEntry[] | null> {
  const client = new Redis(valkeyUrl, {
    connectionName: "jobsmith-status",
    connectTimeout: 1_500,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1,
  });
  client.on("error", () => undefined);
  try {
    const pattern = presencePattern(projectId);
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, found] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== "0");
    if (!keys.length) return [];
    const values = await client.mget(...keys);
    return keys
      .map((key, index) => {
        const payload = parsePresence(values[index] ?? null);
        if (!payload) return null;
        return {
          ...payload,
          memberId: key.slice(key.lastIndexOf(":") + 1),
        };
      })
      .filter((entry): entry is PresenceEntry => entry !== null);
  } catch (error) {
    log.warn(
      { event: "status.presence_unavailable", err: error },
      "Online worker listing unavailable",
    );
    return null;
  } finally {
    client.disconnect();
  }
}
