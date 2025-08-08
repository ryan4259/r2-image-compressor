const { ImagePool } = require('@squoosh/lib');
const fs = require('fs');

(async () => {
  const imagePool = new ImagePool();
  const image = imagePool.ingestImage(fs.readFileSync('test.png'));

  await image.encode({ webp: {} });
  await imagePool.close();

  const compressed = (await image.encodedWith.webp).binary;
  fs.writeFileSync('output.webp', compressed);
  console.log('✅ Compression successful');
})();
