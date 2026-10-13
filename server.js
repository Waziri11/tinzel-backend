import dotenv from 'dotenv';
dotenv.config();

import app from './src/app.js';
import { connectDB } from './src/config/db.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`[Tinzel Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Tinzel Backend] Health endpoint: http://localhost:${PORT}/api/health`);
  console.log(`[Tinzel Backend] Items endpoint: http://localhost:${PORT}/api/items`);

  // Attempt database connection in background
  connectDB();
});
