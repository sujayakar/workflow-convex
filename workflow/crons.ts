import { cronJobs } from "convex/server";
import { functions } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "recover dead jobs",
  {
    minutes: 10,
  },
  functions.recovery.recover,
);

export default crons;
