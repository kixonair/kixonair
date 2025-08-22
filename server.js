import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", (req, res) => res.send("ok"));

// Fixtures route
app.get("/api/fixtures", async (req, res) => {
  const date = req.query.date;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "fallback.json")));
    res.json({ fixtures: data, meta: { sourceCounts: { fallback: data.length } } });
  } catch (err) {
    res.json({ fixtures: [] });
  }
});

// Admin precache
app.post("/admin/precache", (req, res) => {
  const { token, date } = req.query;
  if (token !== process.env.ADMIN_TOKEN) return res.status(403).send("Forbidden");
  res.send(`Precache for ${date} complete`);
});

app.listen(PORT, () => console.log("Kixonair running on", PORT));
