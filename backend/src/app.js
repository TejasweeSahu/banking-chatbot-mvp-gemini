/**
 * Express application factory. Dependencies (database, LLM) are injected so
 * tests can run against an in-memory database and a mocked Gemini client.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/index.js';
import { createApiRouter } from './routes/api.js';
import { frontendDistExists, serveFrontend } from './static.js';

const FRONTEND_DIST = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

export function createApp({ db, llm, frontendDist = config.isProduction ? FRONTEND_DIST : null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(requestId());
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    referrerPolicy: { policy: 'no-referrer' }
  }));
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || config.frontendOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-Request-Id']
  }));
  app.use('/api', express.json({ limit: '32kb', strict: true }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createApiRouter({ db, llm }));
  app.use('/api', notFoundHandler());

  if (frontendDist && frontendDistExists(frontendDist)) serveFrontend(app, frontendDist);

  app.use(errorHandler());
  return app;
}

