const { spawn } = require('child_process');
const path = require('path');

const runPythonScraper = (ingredient, source) => {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scrapers', 'scraper.py');
    const py = spawn('python', [scriptPath, ingredient, source]);

    let data = '';
    py.stdout.on('data', (chunk) => (data += chunk.toString()));
    py.stderr.on('data', (err) => console.error('Error:', err.toString()));

    py.on('close', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (err) {
        reject('Failed to parse Python response');
      }
    });
  });
};

module.exports = runPythonScraper;
