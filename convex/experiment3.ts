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
    const transcription = await step.run(
      "computeTranscription",
      async (ctx) => {
        const blob = await ctx.storage.get(args.storageId);
        if (!blob) {
          throw new Error(`Invalid storage ID: ${args.storageId}`);
        }
        // NB: We have to pass in a `File` object here, since the OpenAI SDK
        // looks at its filename to determine the file type.
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
