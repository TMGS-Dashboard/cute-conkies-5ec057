/**
 * Netlify Scheduled Function: Trigger Garmin sync daily
 * Deploy: add this to netlify/functions/scheduled-garmin-sync.ts (or .js)
 * 
 * Netlify will call this automatically on a schedule.
 * This function then triggers garmin-sync.
 */

export default async (req, context) => {
  // context.schedule is a cron pattern
  // "@daily" = every day at midnight UTC (you can adjust)
  
  console.log("Scheduled: running Garmin sync...");
  
  // Call the garmin-sync function locally
  try {
    const garminSync = require("./garmin-sync.js");
    const result = await garminSync.handler({}, context);
    console.log("Garmin sync result:", result);
    return new Response(JSON.stringify(result), { status: result.statusCode || 200 });
  } catch (err) {
    console.error("Garmin sync error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  schedule: "0 6 * * *",  // 6am UTC = 8am Brussels time (CEST summer / CET winter)
};
