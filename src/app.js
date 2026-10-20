import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { connectDB } from './config/db.js';

import healthRoutes from './routes/health.routes.js';
import itemRoutes from './routes/item.routes.js';
import publicFormRoutes from './routes/publicForm.routes.js';
import clientTrackingRoutes from './routes/clientTracking.routes.js';
import staffAuthRoutes from './routes/staffAuth.routes.js';
import managerRoutes from './routes/manager.routes.js';
import designerRoutes from './routes/designer.routes.js';
import adminRoutes from './routes/admin.routes.js';
import mediaRoutes from './routes/media.routes.js';
import mediaOperationsRoutes from './routes/mediaOperations.routes.js';
import notificationRoutes from './routes/notification.routes.js';

const app = express();

// Middlewares
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(morgan('dev', { skip: (req) => req.originalUrl.startsWith('/api/media-download/') }));
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const started = performance.now();
  const requestPath = req.path.replace(/(\/media-download\/).+/, '$1[redacted]');
  res.on('finish', () => {
    if (/photos|media|upload-session/.test(requestPath)) console.info(JSON.stringify({
      event: 'media_request', requestId: req.requestId, method: req.method, path: requestPath,
      bytes: Number(req.headers['content-length'] || 0), status: res.statusCode,
      durationMs: Math.round(performance.now() - started), dbWaitMs: req.dbWaitMs,
    }));
  });
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/public/media') && req.is('application/json') && Number(req.headers['content-length']) > 256000) {
    return res.status(413).json({ success: false, message: 'Form details are too large' });
  }
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Vercel serves this Express app directly, without running server.js.
app.use('/api', async (req, res, next) => {
  const started = performance.now();
  const connected = await connectDB();
  req.dbWaitMs = Math.round(performance.now() - started);
  if (connected || req.path.startsWith('/health') || req.path.startsWith('/items')) {
    return next();
  }
  return res.status(503).json({
    success: false,
    message: 'Database temporarily unavailable. Please try again shortly.',
  });
});

// Drafts are private and only stream through authenticated routes. Other legacy uploads remain available.
app.use('/uploads/drafts', (_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
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
app.use('/api/public/media', mediaRoutes);
app.use('/api', mediaOperationsRoutes);
app.use('/api/client', clientTrackingRoutes);
app.use('/api/staff', staffAuthRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/designer', designerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);

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
