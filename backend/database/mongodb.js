import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config(); // ✅ Ensure environment variables are loaded

async function connect() {
  const username = process.env.MONGO_DB_USERNAME;
  const password = process.env.MONGO_DB_PASSWORD;
  const url = process.env.MONGO_DB_URL;
  const database = 'dietprices'; // ✅ Specify a database name

  if (!username || !password || !url) {
    console.error('❌ MongoDB credentials are missing in .env file!');
    process.exit(1); // Stop the server if credentials are missing
  }

  try {
    await mongoose.connect(
      `mongodb+srv://${username}:${password}@${url}/${database}?retryWrites=true&w=majority`,
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }
    );
    console.log('✅ MongoDB connection is successful');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1); // Exit the process on failure
  }
}

export default connect;
