import mongoose from 'mongoose';

let connectionPromise;

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) return true;

  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.warn('[DB Warning] MONGODB_URI is not defined in environment variables. Database connection skipped.');
    return false;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,
    }).then((conn) => {
      console.log(`[DB Connected] MongoDB connected: ${conn.connection.host}`);
      return true;
    }).catch((error) => {
      console.warn(`[DB Notice] Could not connect to MongoDB (${error.message}).`);
      return false;
    }).finally(() => {
      connectionPromise = undefined;
    });
  }

  return connectionPromise;
};

export const getDBStatus = () => {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[mongoose.connection.readyState] || 'unknown';
};
