const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/health', (req, res) => res.send('ok'));

app.get('/api/fixtures', (req, res) => {
  res.json({ fixtures: [], meta: { sourceCounts: {} } });
});

app.post('/admin/precache', (req, res) => {
  const { token, date } = req.query;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).send('Forbidden: Invalid admin token');
  }
  console.log('Pre-caching for date', date);
  res.send(`Precache successful for ${date}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port', PORT));
