import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const outcome = v.union(
  v.object({
    type: v.literal("success"),
    result: v.any(),
  }),
  v.object({
    type: v.literal("error"),
    error: v.string(),
  }),
);

export default defineSchema({
  workflows: defineTable({
    startedAt: v.number(),
    actionHandle: v.string(),
    args: v.any(),

    // User visible workflow status.
    state: v.union(
      v.object({
        type: v.literal("running"),
      }),
      v.object({
        type: v.literal("completed"),
        completedAt: v.number(),
        outcome,
      }),
    ),

    // Internal execution status.
    executing: v.boolean(),
    generationNumber: v.number(),
    lastHeartbeat: v.number(),
    sleepingUntil: v.optional(v.number()),
  }).index("execution", ["executing", "lastHeartbeat"]),

  workflowJournal: defineTable({
    workflowId: v.id("workflows"),
    stepNumber: v.number(),
    stepLabel: v.string(),
    startedAt: v.number(),

    state: v.union(
      v.object({
        type: v.literal("running"),
      }),
      v.object({
        type: v.literal("completed"),
        completedAt: v.number(),
        outcome,
      }),
    ),
  }).index("workflowId", ["workflowId", "stepNumber"]),
});
