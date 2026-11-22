import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
if (!config.appSecret) {
  console.error('Ustaw APP_SECRET (min. 16 znakow) - klucz do szyfrowania tokenow.');
  process.exit(1);
}
const { app } = createApp(config);
app.listen(config.port, () => console.log(`Wdrazacz nasluchuje na porcie ${config.port}`));
