const fs   = require('fs');
const path = require('path');

const dir  = './data/sam2';
const file = fs.readdirSync(dir).find(f => f.startsWith('AMP-'));
const CHUNK = 5000000;
let pos = 0, found = false;

function next() {
  if (found) return;
  const stream = fs.createReadStream(path.join(dir, file), {
    encoding: 'utf8', start: pos, end: pos + CHUNK
  });
  let c = '';
  stream.on('data', d => c += d);
  stream.on('end', () => {
    const idx = c.indexOf('Propolipid');
    if (idx !== -1) {
      console.log('TROUVE offset', pos + idx);
      console.log(c.substring(Math.max(0, idx - 200), idx + 800));
      found = true;
    } else {
      pos += CHUNK;
      if (pos < 1600000000) next();
      else console.log('Non trouvé');
    }
  });
}
next();
