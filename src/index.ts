// Must be first: starts OpenTelemetry (env-gated) so auto-instrumentation can
// patch express/mongoose/http before they are imported below.
import './tracing';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import figureRoutes from './routes/figureRoutes';
import userRoutes from './routes/userRoutes';
import authRoutes from './routes/authRoutes';
// Note: /api/search routes removed - frontend uses /figures/search
// import searchRoutes from './routes/searchRoutes';
import adminRoutes, { publicConfigRouter } from './routes/adminRoutes';
import syncRoutes from './routes/syncRoutes';
import lookupRoutes from './routes/lookupRoutes';
import listRoutes from './routes/listRoutes';
import { connectDB } from './config/db';
import { globalErrorHandler } from './middleware/validationMiddleware';
import * as packageJson from '../package.json';
import { createLogger } from './utils/logger';

const logger = createLogger('MAIN');
const registerLogger = createLogger('REGISTER');

dotenv.config();

// Initialize Express app
const app = express();
export { app };
const PORT = parseInt(process.env.PORT || '5080', 10);

// Trust proxy - required for express-rate-limit behind reverse proxy (Coolify/Traefik)
// See: https://express-rate-limit.github.io/ERR_ERL_UNEXPECTED_X_FORWARDED_FOR/
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Debug logging for all requests (JSON.stringify prevents log injection)
app.use((req, res, next) => {
  console.log('[REQUEST]', req.method, JSON.stringify(req.path), JSON.stringify(req.url), 'Host:', JSON.stringify(req.get('host')));
  next();
});

// Routes
app.use('/auth', authRoutes);
app.use('/figures', figureRoutes);
app.use('/users', userRoutes);
// app.use('/api/search', searchRoutes); // Removed - frontend uses /figures/search
app.use('/admin', adminRoutes);
app.use('/sync', syncRoutes);
app.use('/lookup', lookupRoutes);
app.use('/lists', listRoutes);
app.use('/', publicConfigRouter);

// Health check endpoint - validates MongoDB connection
app.get('/health', (req, res) => {
  // mongoose.connection.readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const mongoState = mongoose.connection.readyState;
  const isMongoHealthy = mongoState === 1;

  const status = isMongoHealthy ? 'healthy' : 'unhealthy';
  const httpStatus = isMongoHealthy ? 200 : 503;

  res.status(httpStatus).json({
    service: 'backend',
    version: packageJson.version,
    status,
    mongodb: isMongoHealthy ? 'connected' : 'disconnected'
  });
});


// Version endpoint - aggregates versions from all services via their /health endpoints
app.get('/version', async (req, res) => {
  try {
    const scraperUrl = process.env.SCRAPER_SERVICE_URL || 'http://scraper:3050'; // NOSONAR - internal Docker network

    // Backend version (self)
    const backend = {
      service: 'backend',
      version: packageJson.version,
      status: 'healthy'
    };

    // Scraper version (fetch from /health)
    let scraper = {
      service: 'scraper',
      version: 'unknown',
      status: 'unavailable'
    };

    try {
      const scraperResponse = await fetch(`${scraperUrl}/health`, {
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      if (scraperResponse.ok) {
        const scraperHealth = await scraperResponse.json();
        scraper = {
          service: scraperHealth.service || 'scraper',
          version: scraperHealth.version || 'unknown',
          status: scraperHealth.status || 'healthy'
        };
      }
    } catch (error: any) {
      console.warn('[VERSION] Could not fetch scraper health:', error.message);
    }

    // Build response with all service versions
    const versionInfo = {
      services: {
        backend,
        scraper
      }
    };

    res.json(versionInfo);
  } catch (error: any) {
    console.error('[VERSION] Error in version endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch version information' });
  }
});

// Global error handling middleware (after all routes)
app.use(globalErrorHandler);

// Catch-all for unhandled routes
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Graceful shutdown handling
let server: ReturnType<typeof app.listen>;

const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Close MongoDB connection
  try {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
  } catch (err) {
    logger.error('Error closing MongoDB connection:', err);
  }

  // Exit process
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server - connect to MongoDB first
const startServer = async () => {
  try {
    // Connect to MongoDB before accepting requests
    await connectDB();
    logger.info('MongoDB connected successfully');

    // Now start the HTTP server
    server = app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();
