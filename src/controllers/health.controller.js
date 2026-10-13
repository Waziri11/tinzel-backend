import { getDBStatus } from '../config/db.js';

export const checkHealth = (req, res) => {
  const dbStatus = getDBStatus();
  res.status(200).json({
    status: 'ok',
    message: 'Tinzel Backend API is running smoothly',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      status: dbStatus,
    },
    environment: process.env.NODE_ENV || 'development',
  });
};
