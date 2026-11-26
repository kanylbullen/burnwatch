/**
 * Worker entry point. workerd treats every named export of this module as an
 * entrypoint and refuses to start on a constant, so the relay itself lives in
 * relay.ts and this file exports only the handler.
 */

import { handle, sweep, type Env } from "./relay";

export default {
  fetch: handle,
  async scheduled(_e: ScheduledController, env: Env): Promise<void> {
    await sweep(env);
  },
};
