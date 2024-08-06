import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The schema is entirely optional.
// You can delete this file (schema.ts) and the
// app will continue to work.
// The schema provides more precise TypeScript types.
export default defineSchema({
  messages: defineTable({
    author: v.string(),
    body: v.string(),
  }),

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
        outcome: v.union(
          v.object({
            type: v.literal("success"),
            result: v.any(),
          }),
          v.object({
            type: v.literal("error"),
            error: v.string(),
          }),
          // v.object({
          //   type: v.literal("canceled"),
          // }),
        ),
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
        outcome: v.union(
          v.object({
            type: v.literal("success"),
            result: v.any(),
          }),
          v.object({
            type: v.literal("error"),
            error: v.string(),
          }),
        ),
      }),
    ),
  }).index("workflowId", ["workflowId", "stepNumber"]),
});
