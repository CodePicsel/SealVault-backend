// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser'); // install if missing
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const uploadRoutes = require('./routes/uploads');
const signaturesRouter = require('./routes/signatures');
const signRequestsRouter = require('./routes/sign-requests');
const signingRouter = require('./routes/signing');
const auditRouter = require('./routes/audit');
const emailsRouter = require('./routes/emails');
const requestMeta = require('./middleware/requestMeta');
const auditLogger = require('./middleware/auditLogger');

const app = express();
const PORT = process.env.PORT || 5000;

connectDB(process.env.MONGO_URI || 'mongodb://localhost:27017/myapp');
app.set('trust proxy', 1);

app.use(
  helmet({
    // Allow popups to safely postMessage back (required by some OAuth popups)
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    // You can leave other helmet defaults enabled — this just tweaks COOP
  })
);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' }));
app.use(cookieParser());
app.use(requestMeta);
app.use(auditLogger);

// Set exact frontend origin in env (example: http://localhost:5173)
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'https://sealvaul.netlify.app';

app.use(cors({
  origin: CLIENT_ORIGIN,
  credentials: true
}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX || '10', 10),
  message: 'Too many requests, please try again later.'
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/signatures', signaturesRouter);
app.use('/api/sign-requests', signRequestsRouter);
app.use('/api/signing', signingRouter);
app.use('/api/audit', auditRouter);
app.use('/api/emails', emailsRouter);

const authMiddleware = require('./middleware/auth');
app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ userId: req.user.id });
});

// const appwriteFiles = require('./routes/appwrite-files');
// app.use('/api/appwrite', appwriteFiles);

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
