const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432,
  // Fail fast when no connection is free, instead of waiting forever.
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
  // Client-side cap for when Postgres cannot answer, so cannot time out itself.
  query_timeout: 6000,
});
// Postgres drops idle connections on restart; unhandled, that kills the process.
pool.on("error", (err) => console.error("postgres idle client error:", err.message));

// last_call is bookkeeping: while Redis is down, drop the write, never queue it.
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: 6379,
  enableOfflineQueue: false,
  commandTimeout: 500,
});
redis.on("error", (err) => console.error("redis error:", err.message));

// One summary line per 10 s while writes fail, not one line per request.
let lastCallFailures = 0;
let lastCallError = "";
setInterval(() => {
  if (lastCallFailures === 0) return;
  console.warn(`last_call not recorded ${lastCallFailures} times in 10 s: ${lastCallError}`);
  lastCallFailures = 0;
}, 10_000).unref();

app.get("/api/users", async (req, res) => {
  try {
    // pool.query returns the connection even when the query fails.
    const result = await pool.query("SELECT NOW()");

    redis.set("last_call", Date.now()).catch((err) => {
      lastCallFailures += 1;
      lastCallError = err.message;
    });
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

const server = app.listen(3000, () => console.log("API running on 3000"));

// As PID 1, node ignores SIGTERM unless handled: finish requests, then exit.
// Exit on our own before Docker's 10 s SIGKILL if a request will not finish.
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(1), 8_000).unref();
  server.close(async (err) => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(err ? 1 : 0);
  });
});
