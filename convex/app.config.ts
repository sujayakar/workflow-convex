import { defineApp } from "convex/server";
import workflow from "../workflow/component.config.js";
import workflow2 from "../workflow2/component.config.js";

const app = defineApp();
app.install(workflow, {});
app.install(workflow2, {});
export default app;
