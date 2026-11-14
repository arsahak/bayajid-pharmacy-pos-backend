const mongoose = require("mongoose");

// Mongoose connection caching for serverless
let isConnected = false;

const connectDB = async () => {
  // If already connected, reuse connection
  if (isConnected && mongoose.connection.readyState === 1) {
    console.log("✅ Using existing MongoDB connection");
    return;
  }

  try {
    // Check if MONGO_URI is set
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI environment variable is not set");
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000, // Timeout after 10s
      socketTimeoutMS: 45000, // Fail an operation if the socket is silent for 45s
      // Long-running server (PM2): the DB is far away (~130 ms per round trip)
      // and opening a new TLS connection costs 1-2 s, so keep warm connections
      // open and allow enough parallel queries (dashboard overview runs ~18 at once).
      // On Vercel (serverless) keep the old small pool that closes quickly.
      maxPoolSize: process.env.VERCEL ? 10 : 30,
      minPoolSize: process.env.VERCEL ? 1 : 5,
      maxIdleTimeMS: process.env.VERCEL ? 10000 : 0, // 0 = never close idle connections
    });

    isConnected = true;
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ Error connecting to MongoDB: ${error.message}`);
    isConnected = false;

    // Don't exit in production (Vercel) - let it retry
    if (process.env.NODE_ENV !== "production") {
      process.exit(1);
    } else {
      // In production, throw the error so the serverless function can report it
      throw error;
    }
  }
};

mongoose.connection.on("connected", () => {
  isConnected = true;
  console.log("MongoDB connection established");
});

mongoose.connection.on("disconnected", () => {
  isConnected = false;
  console.warn("MongoDB disconnected");
});

mongoose.connection.on("error", (err) => {
  isConnected = false;
  console.error(`MongoDB error: ${err}`);
});

// Handle process termination
process.on("SIGINT", async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
    console.log("MongoDB connection closed through app termination");
    process.exit(0);
  }
});

module.exports = connectDB;
