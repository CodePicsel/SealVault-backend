// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 5000;

connectDB(process.env.MONGO_URI || 'mongodb://localhost:27017/myapp');

// Middlewares
app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true
}));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 10,
  message: 'Too many requests, please try again later.'
});

app.use('/api/auth', authLimiter, authRoutes);

const authMiddleware = require('./middleware/auth');
app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ userId: req.user.id });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const uploadRoutes = require('./routes/uploads');
app.use('/api/uploads', uploadRoutes);
// server.js
const signaturesRouter = require('./routes/signatures');
app.use('/api/signatures', signaturesRouter);

process.on('SIGTERM', () => {
  console.info('SIGTERM received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});