import { createClient } from "redis";
import type { RedisStreamClient, RedisStreamRead } from "./types.js";

/** Narrows the external client's API to the commands used by this package. */
export function createRedisStreamClient(url: string): RedisStreamClient {
  const client = createClient({ url });
  return {
    get isOpen() { return client.isOpen; },
    connect: async () => { await client.connect(); },
    quit: async () => { await client.quit(); },
    xAdd: (key, id, message, options) => client.xAdd(key, id, message, options),
    xRead: async (stream, options) => client.xRead(stream, options) as Promise<RedisStreamRead[] | null>,
  };
}
