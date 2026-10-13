import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';

import healthRoutes from './routes/health.routes.js';
import itemRoutes from './routes/item.routes.js';
import publicFormRoutes from './routes/publicForm.routes.js';
import clientTrackingRoutes from './routes/clientTracking.routes.js';
import staffAuthRoutes from './routes/staffAuth.routes.js';
import managerRoutes from './routes/manager.routes.js';
import designerRoutes from './routes/designer.routes.js';
import adminRoutes from './routes/admin.routes.js';

const app = express();

// Middlewares
const allowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive in development
      }
    },
    credentials: true,
  })
);

app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static file uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Root Route
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'Tinzel Magazine Conveyor Belt API',
    version: '1.0.0',
    specification: 'STR-TNZ-US-001',
    endpoints: {
      health: '/api/health',
      publicForms: '/api/public/forms',
      clientTracking: '/api/client/request-otp',
      staffAuth: '/api/staff/login',
      manager: '/api/manager/orders',
      designer: '/api/designer/orders',
      admin: '/api/admin/forms',
    },
  });
});

// Route Mounts
app.use('/api/health', healthRoutes);
app.use('/api/items', itemRoutes);
app.use('/api/public', publicFormRoutes);
app.use('/api/client', clientTrackingRoutes);
app.use('/api/staff', staffAuthRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/designer', designerRoutes);
app.use('/api/admin', adminRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

export default app;
