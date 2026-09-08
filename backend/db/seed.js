/**
 * Re-seed the database: `npm run seed` from backend/.
 * Wipes demo rows and re-inserts fresh zones / residents / admins.
 */
require('dotenv').config();
const { seed } = require('./database');

seed(true);
console.log('Seed complete. Start the server with: npm start');