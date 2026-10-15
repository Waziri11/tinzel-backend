import dotenv from 'dotenv';
dotenv.config();

import app from './src/app.js';
import { connectDB } from './src/config/db.js';

const PORT = process.env.PORT || 5001;

app.listen(PORT, async () => {
  console.log(`[Tinzel Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Tinzel Backend] Health endpoint: http://localhost:${PORT}/api/health`);
  console.log(`[Tinzel Backend] Specification: STR-TNZ-US-001 Conveyor Belt`);

  // Connect for local development; Vercel connects in src/app.js.
  await connectDB();
});
