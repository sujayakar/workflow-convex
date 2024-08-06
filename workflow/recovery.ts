import { FunctionHandle } from "convex/server";
import { mutation } from "./_generated/server";

export const recover = mutation({
  handler: async (ctx) => {
    const now = Date.now();
    // Consider a job dead if it hasn't had a heartbeat in the last 10 minutes.
    const cutoff = Date.now() - 10 * 60 * 1000;
    const jobs = await ctx.db
      .query("workflows")
      .withIndex("execution", (q) =>
        q.eq("executing", true).lt("lastHeartbeat", cutoff),
      )
      .collect();
    for (const job of jobs) {
      if (job.state.type !== "running") {
        continue;
      }
      if (job.sleepingUntil && now < job.sleepingUntil) {
        continue;
      }
      console.log(`Restarting dead job ${job._id}`);
      job.executing = false;
      job.generationNumber += 1;
      job.lastHeartbeat = Date.now();
      if (job.sleepingUntil) {
        delete job.sleepingUntil;
      }
      await ctx.db.replace(job._id, job);
      await ctx.scheduler.runAfter(
        0,
        job.actionHandle as FunctionHandle<"action", any, any>,
        {
          workflowId: job._id,
          generationNumber: job.generationNumber,
        },
      );
    }
  },
});
