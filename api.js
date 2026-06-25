(() => {
  async function request(action, payload = {}) {
    if (!window.BA_CONFIG) throw new Error('ไม่พบ BA_CONFIG');
    const idToken = window.liff?.getIDToken?.();
    if (!idToken) throw new Error('ไม่พบ LINE ID Token กรุณาเปิดผ่าน LIFF');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BA_CONFIG.REQUEST_TIMEOUT_MS || 30000);
    try {
      const response = await fetch(BA_CONFIG.EDGE_FUNCTION_URL, {
        method: 'POST', headers: {'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
        body: JSON.stringify({action, payload}), signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) throw new Error(data.message || `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timer); }
  }
  window.BA_API = {request};
})();
