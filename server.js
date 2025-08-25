import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

// ...
const app = express();
app.use(cors());
app.use(express.static('public'));        // make sure a /public folder exists
// ...
const PORT = process.env.PORT || 3000;    // must use Render's PORT
app.listen(PORT, () => console.log('up on', PORT));
