// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser'); // install if missing
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/uploads');
const signaturesRouter = require('./routes/signatures');

const app = express();
const PORT = process.env.PORT || 5000;

connectDB(process.env.MONGO_URI || 'mongodb://localhost:27017/myapp');

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// Set exact frontend origin in env (example: http://localhost:5173)
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(cors({
  origin: CLIENT_ORIGIN,
  credentials: true
}));

if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
  message: 'Too many requests, please try again later.'
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/signatures', signaturesRouter);

const authMiddleware = require('./middleware/auth');
app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ userId: req.user.id });
});

// error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// graceful shutdown
process.on('SIGTERM', () => {
  console.info('SIGTERM received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});