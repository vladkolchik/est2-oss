// Production entry (Docker / self-hosted): one process serves the built frontend from
// ../dist and the API routes from index.js on a single port.
const path = require('path');
const express = require('express');
const app = require('./index.js');

const distDir = path.join(__dirname, '..', 'dist');

// Music and UI sounds are not part of the repository (see public/audio/README.md).
// AUDIO_DIR points at a folder mounted at runtime; files baked into dist/audio work too.
// A missing sound is a plain 404, never the SPA page: the game just plays without it.
const audioDir = process.env.AUDIO_DIR;
if (audioDir) app.use('/audio', express.static(path.resolve(audioDir)));
app.use(express.static(distDir));
app.use('/audio', (req, res) => res.sendStatus(404));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`est2 server (frontend + API) listening on port ${port}`);
});
