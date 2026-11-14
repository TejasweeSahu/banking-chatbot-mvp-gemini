/**
 * @file backend/src/config.js
 * @description Loads environment variables from the root `.env` file into `process.env`
 * using dotenv. Resolves the absolute path relative to this file's directory.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
