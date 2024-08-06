import { defineApp } from "convex/server";
import workflow from "../workflow/component.config.js";

const app = defineApp();
app.install(workflow, {});
export default app;
