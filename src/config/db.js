import mongoose from 'mongoose';

export const connectDB = async () => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.warn('[DB Warning] MONGODB_URI is not defined in environment variables. Database connection skipped.');
    return;
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 2500, // Quick timeout if local MongoDB isn't running
    });
    console.log(`[DB Connected] MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.warn(`[DB Notice] Could not connect to MongoDB (${error.message}). Running in fallback mode.`);
  }
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
