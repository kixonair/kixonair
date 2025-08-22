import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// Health route
app.get("/health", (req, res) => res.send("ok"));

// Fixtures route with fallback
app.get("/api/fixtures", async (req, res) => {
  const date = req.query.date;
  try {
    // TODO: Replace with real ESPN/TheSportsDB fetch
    // Fallback static fixtures
    const fixtures = require("./data/fallback.json");
    res.json({ fixtures, meta: { sourceCounts: { fallback: fixtures.length } } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch fixtures" });
  }
});

// Admin precache
app.post("/admin/precache", (req, res) => {
  const { token, date } = req.query;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send("Forbidden: Invalid token");
  }
  console.log("Pre-caching fixtures for", date);
  res.send(`Precache successful for ${date}`);
});

app.listen(PORT, () => console.log("Kixonair running on port", PORT));
