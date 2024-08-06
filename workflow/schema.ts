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
    args: v.any(),

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

    executing: v.boolean(),
    generationNumber: v.number(),
    lastHeartbeat: v.number(),
  }),

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
