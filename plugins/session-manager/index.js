/**
 * Session Manager plugin for camofox-browser.
 *
 * Enables named, persistent browser profiles using Playwright's userDataDir.
 * Profiles are stored as directories on disk and can be attached to user sessions.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "session-manager": {
 *         "enabled": true,
 *         "profileDir": "/data/profiles/named"
 *       }
 *     }
 *   }
 *
 * Endpoints:
 *   GET    /profiles                    — list all named profiles
 *   POST   /profiles                    — create a new named profile { name }
 *   GET    /profiles/:name              — get profile details
 *   DELETE /profiles/:name              — delete a named profile
 *   POST   /sessions/:userId/profile/:name — attach profile to a user session
 *   DELETE /sessions/:userId/profile    — detach profile from a user session
 *
 * Hooks:
 *   session:creating  — injects userDataDir into contextOptions if user has a mapped profile
 *   session:destroyed — clears the in-memory user→profile mapping
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { requireAuth } from '../../lib/auth.js';

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function getDirectorySize(dirPath) {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySize(full);
      } else {
        total += statSync(full).size;
      }
    }
  } catch {
    // ignore permission errors
  }
  return total;
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;

  const auth = requireAuth(config);

  // Resolve profileDir: plugin config > global config default
  const profileDir = pluginConfig.profileDir || (config.profileDir ? join(config.profileDir, 'named') : null);
  if (!profileDir) {
    log('warn', 'session-manager plugin: no profileDir configured, plugin disabled');
    return;
  }

  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }

  // In-memory mapping: userId -> profileName
  const userProfileMap = new Map();

  function getProfilePath(name) {
    return join(profileDir, name);
  }

  function profileExists(name) {
    return existsSync(getProfilePath(name));
  }

  function buildProfileInfo(name) {
    const p = getProfilePath(name);
    const st = statSync(p);
    return {
      name,
      createdAt: new Date(st.birthtime).toISOString(),
      updatedAt: new Date(st.mtime).toISOString(),
      size: getDirectorySize(p),
    };
  }

  // --- Routes ---

  app.get('/profiles', auth, (req, res) => {
    try {
      const entries = readdirSync(profileDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      const profiles = entries.map(name => buildProfileInfo(name));
      res.json({ profiles });
    } catch (err) {
      log('error', 'failed to list profiles', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/profiles', auth, (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    const safeName = sanitizeName(name);
    if (!safeName) {
      return res.status(400).json({ error: 'invalid profile name' });
    }
    const p = getProfilePath(safeName);
    if (existsSync(p)) {
      return res.status(409).json({ error: 'profile already exists' });
    }
    try {
      mkdirSync(p, { recursive: true });
      log('info', 'profile created', { name: safeName, path: p });
      res.status(201).json(buildProfileInfo(safeName));
    } catch (err) {
      log('error', 'failed to create profile', { name: safeName, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/profiles/:name', auth, (req, res) => {
    const safeName = sanitizeName(req.params.name);
    if (!profileExists(safeName)) {
      return res.status(404).json({ error: 'profile not found' });
    }
    res.json(buildProfileInfo(safeName));
  });

  app.delete('/profiles/:name', auth, (req, res) => {
    const safeName = sanitizeName(req.params.name);
    if (!profileExists(safeName)) {
      return res.status(404).json({ error: 'profile not found' });
    }
    try {
      rmSync(getProfilePath(safeName), { recursive: true, force: true });
      log('info', 'profile deleted', { name: safeName });
      res.json({ deleted: safeName });
    } catch (err) {
      log('error', 'failed to delete profile', { name: safeName, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/sessions/:userId/profile/:name', auth, (req, res) => {
    const { userId, name } = req.params;
    const safeName = sanitizeName(name);
    if (!profileExists(safeName)) {
      return res.status(404).json({ error: 'profile not found' });
    }
    userProfileMap.set(userId, safeName);
    log('info', 'profile attached to session', { userId, profile: safeName });
    res.json({ userId, profile: safeName });
  });

  app.delete('/sessions/:userId/profile', auth, (req, res) => {
    const { userId } = req.params;
    const had = userProfileMap.has(userId);
    userProfileMap.delete(userId);
    log('info', 'profile detached from session', { userId, had });
    res.json({ detached: had, userId });
  });

  // --- Lifecycle hooks ---

  events.on('session:creating', async ({ userId, contextOptions }) => {
    const profileName = userProfileMap.get(userId);
    if (profileName) {
      const p = getProfilePath(profileName);
      contextOptions.userDataDir = p;
      log('info', 'attaching named profile to session via userDataDir', { userId, profile: profileName, path: p });
    }
  });

  events.on('session:destroyed', async ({ userId }) => {
    if (userProfileMap.has(userId)) {
      userProfileMap.delete(userId);
      log('info', 'cleared profile mapping on session destroy', { userId });
    }
  });

  log('info', 'session-manager plugin enabled', { profileDir });
}
