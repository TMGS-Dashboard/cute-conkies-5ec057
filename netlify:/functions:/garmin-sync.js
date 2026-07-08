/**
 * Netlify Function: Garmin → Supabase daily sync
 * Deploy: add this to netlify/functions/garmin-sync.js
 * 
 * Requires environment variables (set in Netlify dashboard):
 *   GARMIN_EMAIL, GARMIN_PASSWORD, SUPABASE_URL, SUPABASE_ANON_KEY
 * 
 * Trigger: manually via Netlify dashboard, or set up a scheduled function.
 */

const https = require("https");

function fetchUrl(url, method = "GET", headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const isHttps = opts.protocol === "https:";
    const client = isHttps ? https : require("http");

    const req = client.request(
      {
        method,
        hostname: opts.hostname,
        path: opts.pathname + opts.search,
        headers: { "User-Agent": "garmin-sync/1.0", ...headers },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function garminLogin(email, password) {
  /**
   * Get MFA token from Garmin Connect.
   * Returns { mfaToken } or throws.
   */
  const body = JSON.stringify({
    login: email,
    password: password,
    rememberMe: true,
  });

  const res = await fetchUrl("https://sso.garmin.com/sso/login", "POST", {
    "Content-Type": "application/json",
    "Content-Length": body.length,
  }, body);

  if (res.status >= 400) {
    throw new Error(`Garmin login failed: ${res.status}`);
  }

  // Look for ticket in response or Location header
  let mfaToken = null;
  if (res.body.includes("mfaToken")) {
    const m = res.body.match(/"mfaToken":"([^"]+)"/);
    if (m) mfaToken = m[1];
  }
  if (!mfaToken) {
    throw new Error("No MFA token from Garmin — check email/password");
  }
  return mfaToken;
}

async function garminStats(mfaToken, dateStr) {
  /**
   * Fetch one day of comprehensive stats from daily summary.
   * dateStr = "2025-01-15"
   * Includes: steps, calories, HR, HRV, body battery, training load, load focus.
   */
  const url = `https://connect.garmin.com/usersummary-service/usersummary/daily/${dateStr}`;
  const res = await fetchUrl(url, "GET", {
    Cookie: `SESSIONID=${mfaToken}`,
  });

  if (res.status >= 400) {
    console.warn(`Garmin stats ${dateStr}: ${res.status}`);
    return {};
  }

  const data = JSON.parse(res.body);
  const summary = data.summarizedDailyValues || {};
  const stats = data.dailyStepData || {};

  return {
    steps: summary.totalSteps || stats.steps,
    active_kcal: summary.activeKilocalories || null,
    resting_hr: summary.restingHeartRate || null,
    body_battery: summary.bodyBatteryMostRecentValue || null,
    training_load: summary.trainingLoadFocus || null,
    load_focus: summary.loadFocus || null,
  };
}

async function garminSleep(mfaToken, dateStr) {
  /**
   * Fetch sleep and sleep score for a date.
   */
  const url = `https://connect.garmin.com/sleep-service/sleep/daily/${dateStr}`;
  const res = await fetchUrl(url, "GET", {
    Cookie: `SESSIONID=${mfaToken}`,
  });

  if (res.status >= 400) return { sleep_h: null, sleep_score: null };

  const data = JSON.parse(res.body);
  const daily = data.dailySleepDTO || {};
  const secs = daily.sleepTimeSeconds;
  const score = daily.overallSleepScore || data.sleepScores?.[0]?.overallSleepScore || null;
  
  return {
    sleep_h: secs ? Math.round((secs / 3600) * 100) / 100 : null,
    sleep_score: score,
  };
}

async function garminHrv(mfaToken, dateStr) {
  /**
   * Fetch HRV for a date.
   */
  const url = `https://connect.garmin.com/hrv-service/hrv/daily/${dateStr}`;
  const res = await fetchUrl(url, "GET", {
    Cookie: `SESSIONID=${mfaToken}`,
  });

  if (res.status >= 400) return { hrv_ms: null };

  const data = JSON.parse(res.body);
  const summary = (data.hrvSummary || {}).lastNightAvg;
  return { hrv_ms: summary || null };
}

async function fetchDay(mfaToken, dateStr) {
  /**
   * Fetch all metrics for one day.
   * Returns: date, steps, active_kcal, resting_hr, body_battery, training_load, load_focus,
   *          sleep_h, sleep_score, hrv_ms
   */
  const [stats, sleep, hrv] = await Promise.all([
    garminStats(mfaToken, dateStr),
    garminSleep(mfaToken, dateStr),
    garminHrv(mfaToken, dateStr),
  ]);

  return { date: dateStr, ...stats, ...sleep, ...hrv };
}

async function postToSupabase(url, key, rows) {
  /**
   * Upsert rows into health_inbox.
   */
  const body = JSON.stringify(rows);
  const res = await fetchUrl(url, "POST", {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
    "Content-Length": body.length,
  }, body);

  if (res.status >= 300) {
    throw new Error(`Supabase error ${res.status}: ${res.body}`);
  }
}

exports.handler = async (event, context) => {
  try {
    const email = process.env.GARMIN_EMAIL;
    const password = process.env.GARMIN_PASSWORD;
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_ANON_KEY;

    if (!email || !password || !supaUrl || !supaKey) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing env vars" }),
      };
    }

    console.log("Logging in to Garmin...");
    const mfaToken = await garminLogin(email, password);
    console.log("Login OK");

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const fmt = (d) => d.toISOString().slice(0, 10);
    const dates = [fmt(yesterday), fmt(today)];

    const rows = [];
    for (const dateStr of dates) {
      console.log(`Fetching ${dateStr}...`);
      const data = await fetchDay(mfaToken, dateStr);
      // Only post if we got something beyond the date
      if (Object.keys(data).length > 1 && Object.values(data).some(v => v !== null)) {
        rows.push(data);
        console.log(`  -> ${JSON.stringify(data)}`);
      }
    }

    if (rows.length > 0) {
      console.log(`Posting ${rows.length} day(s) to Supabase...`);
      await postToSupabase(
        `${supaUrl.replace(/\/$/, "")}/rest/v1/health_inbox?on_conflict=date`,
        supaKey,
        rows
      );
      console.log("Done");
    } else {
      console.log("No data to post");
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, rows: rows.length }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
