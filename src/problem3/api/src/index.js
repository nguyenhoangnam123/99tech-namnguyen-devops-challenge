const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  port: 5432,
  // Fail fast when no connection is free, instead of waiting forever.
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
// Postgres drops idle connections on restart; unhandled, that kills the process.
pool.on("error", (err) => console.error("postgres idle client error:", err.message));

const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });

app.get("/api/users", async (req, res) => {
  try {
    // pool.query returns the connection even when the query fails.
    const result = await pool.query("SELECT NOW()");

    await redis.set("last_call", Date.now());
    res.json({ ok: true, time: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(3000, () => console.log("API running on 3000"));
