import { v } from "convex/values";
import { OpenAI } from "openai";
import { WorkflowClient } from "../workflow/client";
import { app, mutation } from "./_generated/server";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const workflow = new WorkflowClient(app.workflow);

export const experiment = workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (step, args) => {
    // You can put the workflow to sleep for as long as you'd like!
    // This is just 10s, but you can make it days, months, etc.
    await step.sleep(10 * 1000);

    // Execute steps inline with a regular action ctx.
    const transcription = await step.run(
      "computeTranscription",
      async (ctx) => {
        const blob = await ctx.storage.get(args.storageId);
        if (!blob) {
          throw new Error(`Invalid storage ID: ${args.storageId}`);
        }
        const file = new File([blob], `${args.storageId}.mp3`, {
          type: "audio/mpeg",
        });
        const transcription = await openai.audio.transcriptions.create({
          file,
          model: "whisper-1",
        });
        return transcription.text;
      },
    );

    const embedding = await step.run("computeEmbedding", async (ctx) => {
      const embedding = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: [transcription],
      });
      return embedding.data[0].embedding;
    });

    console.log(embedding);
    return null;
  },
});

export const kickoffWorkflow = mutation({
  handler: async (ctx) => {
    const storageId = "kg2c4mhdc0xvt772gzyk26g1856yayky" as Id<"_storage">;
    await workflow.start(ctx, api.experiment3.experiment, { storageId });
  },
});
