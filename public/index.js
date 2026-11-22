import { api, bindLogout } from './common.js';

bindLogout();
api('/api/me').then((me) => {
  document.getElementById('info').textContent =
    `Zalogowano jako ${me.username}. Lista repozytoriów pojawi się w etapie 3.`;
});
