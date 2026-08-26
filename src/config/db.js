const mongoose = require('mongoose');

// Errors propagate to the caller (server.js's bootstrap()) instead of exiting
// here — a transient connection blip shouldn't crash-loop the whole process
// when the HTTP server is already listening and serving other requests.
const connectDB = async () => {
  const conn = await mongoose.connect(process.env.MONGODB_URI);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
};

module.exports = connectDB;
