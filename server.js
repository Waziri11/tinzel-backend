import dotenv from 'dotenv';
dotenv.config();

import app from './src/app.js';
import { connectDB, getDBStatus } from './src/config/db.js';
import { seedInitialData } from './src/utils/seedData.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`[Tinzel Backend] Server running on http://localhost:${PORT}`);
  console.log(`[Tinzel Backend] Health endpoint: http://localhost:${PORT}/api/health`);
  console.log(`[Tinzel Backend] Specification: STR-TNZ-US-001 Conveyor Belt`);

  // Attempt database connection in background
  await connectDB();
  if (getDBStatus() === 'connected') {
    await seedInitialData();
  }
});
